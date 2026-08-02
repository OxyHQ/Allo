import { logger } from '@/utils/logger';

import { matrixServerNameOf, matrixUserIdFor } from './matrixIdentity';
import {
  MatrixClientNotStartedError,
  matrixRuntime,
  type MatrixRuntimeLike,
} from './matrixRuntime';
import { planConversation, type NewConversationRequest } from './newConversation';
import { roomListSource, type RoomListLike } from './roomListSource';

/**
 * Starting a conversation on the homeserver.
 *
 * Three things happen here that the port deliberately does not do, because each
 * of them is about Allo rather than about Matrix:
 *
 * 1. **The people are named.** The screen holds Oxy user ids; a homeserver
 *    invites MXIDs. See `matrixIdentity.ts` for why that translation is
 *    arithmetic.
 * 2. **The room is waited for.** `createRoom` answers with a room id before sync
 *    has delivered the room, and the port says so — so navigating straight to it
 *    opens a conversation the client has never heard of.
 * 3. **Nothing is written to the conversations store.** The Matrix room list is
 *    fed by sync and by nothing else; a row inserted here would be a second
 *    source of truth for the same conversation, and the one that is wrong.
 */

/**
 * How long to wait for sync to deliver a room that has just been created.
 *
 * Generous, because the cost of being wrong is asymmetric. Waiting a moment too
 * long is a spinner on a button the user just pressed; giving up too early opens
 * a conversation whose name, members and timeline are all missing, and on the
 * web that state does not repair itself until something else makes the client
 * look at the room again.
 */
const ROOM_ARRIVAL_TIMEOUT_MS = 15_000;

export class MatrixConversationCreator {
  readonly #runtime: MatrixRuntimeLike;
  readonly #rooms: RoomListLike;
  readonly #arrivalTimeoutMs: number;

  constructor(
    runtime: MatrixRuntimeLike,
    rooms: RoomListLike,
    arrivalTimeoutMs: number = ROOM_ARRIVAL_TIMEOUT_MS,
  ) {
    this.#runtime = runtime;
    this.#rooms = rooms;
    this.#arrivalTimeoutMs = arrivalTimeoutMs;
  }

  /**
   * Creates the conversation, and answers with the room id to open.
   *
   * Encryption is not among the arguments and cannot be: see
   * `lib/matrix/roomCreation.ts`. A direct message with somebody the viewer
   * already has one with reuses it rather than minting a second — that is the
   * port's rule, not this one's, and it is why this does not look for an
   * existing conversation itself. The room list here is the same rooms the
   * port's own `m.direct` lookup reads, one translation later.
   */
  readonly create = async (request: NewConversationRequest): Promise<string> => {
    const plan = planConversation(request);
    const viewerId = this.#runtime.getState().userId;
    if (viewerId === undefined) {
      throw new MatrixClientNotStartedError('Creating a conversation');
    }

    const serverName = matrixServerNameOf(viewerId);
    const roomId = await this.#runtime
      .client('Creating a conversation')
      .createRoom({
        invite: plan.participantIds.map((id) => matrixUserIdFor(id, serverName)),
        name: plan.name,
        isDirect: plan.isDirect,
      });

    await this.#waitForRoom(roomId);
    return roomId;
  };

  /**
   * Waits until the room list holds the new room.
   *
   * The homeserver has the room the moment `createRoom` resolves; this client
   * does not, and everything the conversation screen draws — its name, its
   * members, its timeline — comes from sync. Opening it first shows an empty
   * conversation with a room id for a title.
   *
   * **A timeout resolves rather than rejects.** The room exists: the invitations
   * have gone out and the other people can already see it. Refusing to open it
   * because this device's sync is slow would be reporting a failure that did not
   * happen, and would leave the user with no way back to a conversation they
   * just made.
   */
  #waitForRoom(roomId: string): Promise<void> {
    if (this.#hasRoom(roomId)) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      let settled = false;
      let unsubscribe: (() => void) | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;

      const finish = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
        }
        unsubscribe?.();
        resolve();
      };

      timer = setTimeout(() => {
        logger.warn(
          `[chat] the room ${roomId} was created but has not been delivered by ` +
            `sync within ${this.#arrivalTimeoutMs}ms; opening it anyway`,
        );
        finish();
      }, this.#arrivalTimeoutMs);

      unsubscribe = this.#rooms.subscribe(() => {
        if (this.#hasRoom(roomId)) {
          finish();
        }
      });
      if (settled) {
        // The subscription reported the room before `subscribe` returned, so
        // `finish` had nothing to unsubscribe from yet.
        unsubscribe();
        return;
      }
      // Subscribing is what opens the list, so the room may already be in the
      // first snapshot it publishes.
      if (this.#hasRoom(roomId)) {
        finish();
      }
    });
  }

  #hasRoom(roomId: string): boolean {
    return this.#rooms.getSnapshot().some((room) => room.roomId === roomId);
  }
}

/** The app's one creator, bound to the app's runtime and its room list. */
export const matrixConversationCreator = new MatrixConversationCreator(
  matrixRuntime,
  roomListSource,
);
