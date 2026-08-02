import type { AlloRoomDetails, AlloRoomTrust, AlloUnsubscribe } from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { matrixServerNameOf, matrixUserIdFor } from './matrixIdentity';
import {
  MatrixClientNotStartedError,
  matrixRuntime,
  type MatrixRuntimeLike,
} from './matrixRuntime';

/**
 * Administering a room: who is in it, who else may be asked, what it is called,
 * and leaving it.
 *
 * An external store per room, the same shape as `timelineSource.ts`, and for the
 * same reason: `useSyncExternalStore` is what binds it to React without an
 * Effect, and the state — the details, whether they are being read, what went
 * wrong last time — belongs to the room rather than to whichever screen is
 * drawing it.
 *
 * **The port reads a snapshot, not a subscription** (see
 * `AlloChatClient.roomDetails`), so this reloads at two moments and no others:
 * when something starts watching it, and after an action of the viewer's own
 * changes what it would answer. A change made from another device — somebody
 * else joining, a rename from another client — is not seen until the screen is
 * opened again. That is a limit worth knowing about and is written down in
 * `docs/matrix/ui-wiring.md` §9.
 *
 * Nothing here is optimistic. An invitation that the homeserver refuses must not
 * leave a name in the member list, and a rename it refuses must not leave the
 * new title on screen: both would be the UI telling the user something the
 * server disagrees with, which is the one thing an administration screen cannot
 * do. Every action therefore waits for the homeserver and then re-reads.
 */

export interface RoomAdminSnapshot {
  /** What the room is, or `undefined` before the first read has finished. */
  readonly details: AlloRoomDetails | undefined;
  /**
   * What this device knows about the identity of everybody in it.
   *
   * Read beside {@link details} and reported separately, because it can fail on
   * its own: the crypto stack starts in the background, and a member list that
   * refused to draw because an identity could not be looked up would take a
   * working screen away over something that is nobody's fault and resolves
   * itself. `undefined` therefore means "not known here", and the screen says
   * so rather than drawing everybody as untrusted.
   */
  readonly trust: AlloRoomTrust | undefined;
  readonly isLoading: boolean;
  /**
   * Why the last read failed, in words a screen can show.
   *
   * Kept separate from {@link details} rather than replacing them: a read that
   * failed after an earlier one worked leaves the earlier answer on screen,
   * which is older but true, and says what went wrong beside it.
   */
  readonly error: string | undefined;
}

/** What inviting several people ended up doing. */
export interface InviteOutcome {
  /** Oxy user ids the homeserver accepted an invitation for. */
  readonly invited: readonly string[];
  /**
   * The ones it did not, and why.
   *
   * A list rather than a thrown error because inviting three people is three
   * requests: the first two can succeed and the third fail, and both halves of
   * that are true at once. A caller that only heard about the failure would
   * report a group as unchanged when two people are already in it.
   */
  readonly failed: readonly { readonly userId: string; readonly reason: string }[];
}

const EMPTY: RoomAdminSnapshot = {
  details: undefined,
  trust: undefined,
  isLoading: false,
  error: undefined,
};

export class RoomAdminSource {
  readonly #runtime: MatrixRuntimeLike;
  readonly #roomId: string;
  readonly #onIdle: () => void;
  readonly #listeners = new Set<() => void>();

  #snapshot: RoomAdminSnapshot = EMPTY;
  #watchingRuntime: AlloUnsubscribe | undefined;
  #loading: Promise<void> | undefined;
  /** See `roomListSource.ts`: invalidates a read from a session that has ended. */
  #generation = 0;

  constructor(runtime: MatrixRuntimeLike, roomId: string, onIdle: () => void) {
    this.#runtime = runtime;
    this.#roomId = roomId;
    this.#onIdle = onIdle;
  }

  readonly subscribe = (listener: () => void): AlloUnsubscribe => {
    this.#listeners.add(listener);
    if (this.#watchingRuntime === undefined) {
      this.#watchingRuntime = this.#runtime.subscribe(this.#onRuntimeChanged);
      // Subscribing is what reads the room, so no screen has to remember to.
      this.#onRuntimeChanged();
    }
    return () => {
      this.#listeners.delete(listener);
      if (this.#listeners.size === 0) {
        this.#close();
      }
    };
  };

  readonly getSnapshot = (): RoomAdminSnapshot => this.#snapshot;

  /** Reads the room again. Safe to call while a read is already running. */
  readonly refresh = (): Promise<void> => {
    if (this.#loading !== undefined) {
      return this.#loading;
    }
    const generation = this.#generation;
    this.#publish({ isLoading: true });
    const loading = this.#read(generation).finally(() => {
      if (this.#loading === loading) {
        this.#loading = undefined;
      }
    });
    this.#loading = loading;
    return loading;
  };

  /**
   * Invites people to this room, one request each.
   *
   * Sequentially, not all at once: a homeserver rate-limits invitations, and
   * several in flight together is the shape that gets a `M_LIMIT_EXCEEDED` for
   * some of them and not others. Slower, and every answer belongs to somebody.
   *
   * The ids are Oxy's, as every screen has them; the homeserver is told MXIDs.
   * An id that cannot become one fails on its own rather than abandoning the
   * others — one unusable account must not stop a family group being completed.
   */
  readonly invite = async (oxyUserIds: readonly string[]): Promise<InviteOutcome> => {
    const client = this.#runtime.client('Inviting somebody');
    const serverName = matrixServerNameOf(this.#requireViewerId('Inviting somebody'));

    const invited: string[] = [];
    const failed: { userId: string; reason: string }[] = [];
    for (const userId of oxyUserIds) {
      try {
        await client.inviteToRoom(this.#roomId, matrixUserIdFor(userId, serverName));
        invited.push(userId);
      } catch (error) {
        logger.error(`[chat] ${userId} could not be invited to ${this.#roomId}`, error);
        failed.push({ userId, reason: describe(error) });
      }
    }

    if (invited.length > 0) {
      // Only when something changed. A read after a batch that failed entirely
      // would report the same room and hide the failure behind a spinner.
      await this.refresh();
    }
    return { invited, failed };
  };

  readonly rename = async (name: string): Promise<void> => {
    await this.#runtime.client('Renaming a conversation').renameRoom(this.#roomId, name);
    await this.refresh();
  };

  /**
   * Leaves the room.
   *
   * Nothing is refreshed afterwards, and that is not an omission: the viewer is
   * no longer in the room, so there is nothing here they are still allowed to
   * read. The screen that called this navigates away, and sync removes the room
   * from the conversation list on its own.
   */
  readonly leave = async (): Promise<void> => {
    await this.#runtime.client('Leaving a conversation').leaveRoom(this.#roomId);
  };

  #requireViewerId(operation: string): string {
    const viewerId = this.#runtime.getState().userId;
    if (viewerId === undefined) {
      throw new MatrixClientNotStartedError(operation);
    }
    return viewerId;
  }

  async #read(generation: number): Promise<void> {
    try {
      const details = await this.#runtime
        .client('Reading a conversation')
        .roomDetails(this.#roomId);
      if (generation === this.#generation) {
        this.#publish({ details, isLoading: false, error: undefined });
      }
    } catch (error) {
      logger.error(`[chat] the members of ${this.#roomId} could not be read`, error);
      if (generation === this.#generation) {
        this.#publish({ isLoading: false, error: describe(error) });
      }
      return;
    }
    await this.#readTrust(generation);
  }

  /**
   * Reads what this device knows about the members' identities.
   *
   * After the members and not with them, and allowed to fail on its own: the
   * screen's job is to show who is in the conversation, and a crypto stack that
   * is still starting must not take that away. What it costs when it fails is a
   * line saying the identities are not known here — see
   * {@link RoomAdminSnapshot.trust}.
   */
  async #readTrust(generation: number): Promise<void> {
    try {
      const trust = await this.#runtime
        .client("Reading a conversation's trust")
        .roomTrust(this.#roomId);
      if (generation === this.#generation) {
        this.#publish({ trust });
      }
    } catch (error) {
      logger.error(
        `[chat] the identities of the people in ${this.#roomId} could not be read`,
        error,
      );
      if (generation === this.#generation) {
        this.#publish({ trust: undefined });
      }
    }
  }

  readonly #onRuntimeChanged = (): void => {
    if (this.#runtime.getState().phase === 'ready') {
      if (this.#snapshot.details === undefined && this.#loading === undefined) {
        void this.refresh();
      }
      return;
    }
    // The session went away. What was read belonged to it, and a details screen
    // showing the members of a room nobody is signed in to is a lie with a
    // spinner next to it.
    this.#generation += 1;
    this.#loading = undefined;
    this.#snapshot = EMPTY;
    this.#emit();
  };

  #close(): void {
    this.#generation += 1;
    this.#loading = undefined;
    this.#watchingRuntime?.();
    this.#watchingRuntime = undefined;
    this.#snapshot = EMPTY;
    this.#onIdle();
  }

  #publish(patch: Partial<RoomAdminSnapshot>): void {
    const next: RoomAdminSnapshot = { ...this.#snapshot, ...patch };
    if (
      next.details === this.#snapshot.details &&
      next.trust === this.#snapshot.trust &&
      next.isLoading === this.#snapshot.isLoading &&
      next.error === this.#snapshot.error
    ) {
      return;
    }
    this.#snapshot = next;
    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) {
      listener();
    }
  }
}

/** What went wrong, in the words the homeserver or the SDK used. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The open administration screens, one per room.
 *
 * A registry for the same reason `timelineSource` has one: two components
 * drawing the same room — the details pane and the screen behind it on a wide
 * window — must not each read the member list.
 */
const sources = new Map<string, RoomAdminSource>();

export function roomAdminSource(roomId: string): RoomAdminSource {
  const existing = sources.get(roomId);
  if (existing !== undefined) {
    return existing;
  }
  const source = new RoomAdminSource(matrixRuntime, roomId, () => {
    if (sources.get(roomId) === source) {
      sources.delete(roomId);
    }
  });
  sources.set(roomId, source);
  return source;
}
