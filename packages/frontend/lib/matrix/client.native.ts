import {
  ClientBuilder,
  LogLevel,
  MessageType,
  RoomListEntriesDynamicFilterKind,
  SlidingSyncVersion,
  SlidingSyncVersionBuilder,
  initPlatform,
  messageEventContentNew,
} from '@unomed/react-native-matrix-sdk';
import type {
  ClientLike,
  RoomLike,
  RoomListEntriesListener,
  RoomListEntriesUpdate,
  RoomListEntriesWithDynamicAdaptersResultLike,
  Session,
  SyncServiceLike,
  TaskHandleLike,
  TimelineDiff,
  TimelineItemLike,
  TimelineLike,
} from '@unomed/react-native-matrix-sdk';

import { MatrixRoomNotFoundError, MatrixSyncNotStartedError } from '@/lib/matrix/errors';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloEncryptionState,
  AlloPaginationOutcome,
  AlloPasswordCredentials,
  AlloRoomListHandle,
  AlloRoomSummary,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { applyListUpdate } from './native/listDiff';
import { RoomSummaryCache } from './native/roomSummaries';
import { TimelineProjection } from './native/timelineProjection';
import { toEncryptionState, toSyncState } from './native/translate';

/**
 * The native implementation of the Allo chat port, over
 * `@unomed/react-native-matrix-sdk` (uniffi bindings to matrix-rust-sdk).
 *
 * Metro serves this file on iOS and Android and `client.ts` on web. The contract
 * both answer to is in `lib/matrix/types.ts`.
 */

const LOG_TAG = '[matrix]';

/**
 * How many rooms the room list holds.
 *
 * The binding only offers a paginated view of the room list, and Allo's
 * conversation list is not paginated: it wants every conversation. One page this
 * size covers any realistic account; beyond it, the least recently active
 * conversations would be missing.
 */
const ROOM_LIST_PAGE_SIZE = 500;

/**
 * Rust's logging and callback machinery is process-global and has to be set up
 * before any other call into the SDK. Guarded by a module-level flag rather than
 * anything React-shaped: this must happen exactly once per process, and an Effect
 * runs twice under StrictMode.
 */
let platformInitialized = false;

function ensurePlatformInitialized(): void {
  if (platformInitialized) {
    return;
  }
  initPlatform(
    {
      logLevel: process.env.NODE_ENV === 'production' ? LogLevel.Warn : LogLevel.Debug,
      traceLogPacks: [],
      extraTargets: [],
      writeToStdoutOrSystem: true,
      writeToFiles: undefined,
    },
    false,
  );
  platformInitialized = true;
}

export const createAlloChatClient: AlloChatClientFactory = async (config) => {
  ensurePlatformInitialized();
  return new NativeAlloChatClient(await buildClient(config));
};

async function buildClient(config: AlloChatClientConfig): Promise<ClientLike> {
  const builder = new ClientBuilder()
    .homeserverUrl(config.homeserverUrl)
    // The binding's only sliding sync options are "none" and "native": there is
    // no proxy fallback, so a homeserver that does not serve native sliding sync
    // makes `build()` fail with `ClientBuildError.SlidingSyncVersion` instead of
    // degrading quietly. That is a deployment requirement of the mobile app, and
    // failing loudly here is the point. See `docs/matrix/client-strategy.md` §2.1.
    .slidingSyncVersionBuilder(SlidingSyncVersionBuilder.DiscoverNative);

  const withStore =
    config.store.kind === 'in-memory'
      ? builder.inMemoryStore()
      : builder.sessionPaths(config.store.dataPath, config.store.cachePath);

  return withStore.build();
}

class NativeAlloChatClient implements AlloChatClient {
  readonly #client: ClientLike;
  readonly #syncStateListeners = new Set<(state: AlloSyncState) => void>();
  readonly #roomLists = new Set<NativeRoomListHandle>();
  readonly #timelines = new Set<NativeTimelineHandle>();

  #sync: SyncServiceLike | undefined;
  #syncStateHandle: TaskHandleLike | undefined;
  #syncState: AlloSyncState = 'idle';

  constructor(client: ClientLike) {
    this.#client = client;
  }

  async logIn(credentials: AlloPasswordCredentials): Promise<AlloSession> {
    await this.#client.login(
      credentials.username,
      credentials.password,
      credentials.initialDeviceName,
      undefined,
    );
    return this.session();
  }

  async restoreSession(session: AlloSession): Promise<void> {
    await this.#client.restoreSession(toSdkSession(session));
  }

  session(): AlloSession {
    return toAlloSession(this.#client.session());
  }

  async startSync(): Promise<void> {
    if (this.#sync === undefined) {
      this.#sync = await this.#client.syncService().finish();
      this.#syncStateHandle = this.#sync.state({
        onUpdate: (state) => {
          this.#syncState = toSyncState(state);
          for (const listener of this.#syncStateListeners) {
            listener(this.#syncState);
          }
        },
      });
    }
    await this.#sync.start();
  }

  async stopSync(): Promise<void> {
    await this.#sync?.stop();
  }

  observeSyncState(onChange: (state: AlloSyncState) => void): AlloUnsubscribe {
    this.#syncStateListeners.add(onChange);
    // Delivering the current state right away is what lets a caller subscribe
    // before starting the sync loop and still observe every transition.
    onChange(this.#syncState);
    return () => {
      this.#syncStateListeners.delete(onChange);
    };
  }

  async observeRooms(
    onChange: (rooms: readonly AlloRoomSummary[]) => void,
  ): Promise<AlloRoomListHandle> {
    const roomList = await this.#requireSync('Observing the room list')
      .roomListService()
      .allRooms();
    const handle = new NativeRoomListHandle(onChange, () => {
      this.#roomLists.delete(handle);
    });
    handle.attach(roomList.entriesWithDynamicAdapters(ROOM_LIST_PAGE_SIZE, handle.listener));
    this.#roomLists.add(handle);
    return handle;
  }

  async roomEncryption(roomId: string): Promise<AlloEncryptionState> {
    // `latestEncryptionState()` and not `isEncrypted()`: the latter answers with a
    // boolean, which forces "sync has not told us yet" to be reported as "not
    // encrypted". That false negative is what the UI would draw as an open
    // padlock on an encrypted room, and it is the normal state of a room that has
    // just been created.
    const room = this.#requireRoom(roomId, "Reading a room's encryption state");
    return toEncryptionState(await room.latestEncryptionState());
  }

  async openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle> {
    const room = this.#requireRoom(roomId, 'Opening a timeline');
    const timeline = await room.timeline();
    const handle = new NativeTimelineHandle(timeline, onChange, () => {
      this.#timelines.delete(handle);
    });
    await handle.attach();
    this.#timelines.add(handle);
    return handle;
  }

  async close(): Promise<void> {
    for (const timeline of [...this.#timelines]) {
      timeline.close();
    }
    for (const roomList of [...this.#roomLists]) {
      roomList.close();
    }
    this.#syncStateListeners.clear();
    this.#syncStateHandle?.cancel();
    this.#syncStateHandle = undefined;

    const sync = this.#sync;
    // Dropped, not merely stopped: the state listener is gone with it, and
    // keeping the stopped service would let a later startSync() bring sync back
    // up with nothing reporting its state.
    this.#sync = undefined;
    this.#syncState = 'idle';
    await sync?.stop();
  }

  #requireSync(operation: string): SyncServiceLike {
    if (this.#sync === undefined) {
      throw new MatrixSyncNotStartedError(operation);
    }
    return this.#sync;
  }

  #requireRoom(roomId: string, operation: string): RoomLike {
    // Rooms come from the state store, which is what sync fills: without it the
    // client knows no rooms at all, and reporting that as "no such room" would
    // send the caller looking for the wrong problem.
    this.#requireSync(operation);
    const room = this.#client.getRoom(roomId);
    if (room === undefined) {
      throw new MatrixRoomNotFoundError(roomId);
    }
    return room;
  }
}

class NativeRoomListHandle implements AlloRoomListHandle {
  readonly #onChange: (rooms: readonly AlloRoomSummary[]) => void;
  readonly #onClose: () => void;
  readonly #entries: RoomLike[] = [];
  readonly #summaries = new RoomSummaryCache();

  #rooms: readonly AlloRoomSummary[] = [];
  #subscription: RoomListEntriesWithDynamicAdaptersResultLike | undefined;
  #stream: TaskHandleLike | undefined;
  #closed = false;
  /**
   * Reading a batch's summaries is async, so two batches could publish out of
   * order and the list would jump back to an older state. Batches are queued, and
   * one that a newer batch has already superseded is dropped before it costs a
   * single call across the FFI boundary.
   */
  #queue: Promise<void> = Promise.resolve();
  #generation = 0;

  constructor(onChange: (rooms: readonly AlloRoomSummary[]) => void, onClose: () => void) {
    this.#onChange = onChange;
    this.#onClose = onClose;
  }

  readonly listener: RoomListEntriesListener = {
    onUpdate: (updates: RoomListEntriesUpdate[]): void => {
      try {
        for (const update of updates) {
          applyListUpdate(this.#entries, update);
        }
      } catch (error) {
        // The mirrored list and Rust's have diverged, so every later index refers
        // to a list that no longer exists. Carrying on would show the user a
        // conversation list in the wrong order, which is worse than a stale one.
        logger.error(`${LOG_TAG} room list update could not be applied`, error);
        return;
      }
      const generation = ++this.#generation;
      const entries = [...this.#entries];
      this.#queue = this.#queue.then(() => this.#publish(generation, entries));
    },
  };

  attach(subscription: RoomListEntriesWithDynamicAdaptersResultLike): void {
    this.#subscription = subscription;
    this.#stream = subscription.entriesStream();
    // Until a filter is set the dynamic view holds no page and the stream stays
    // silent. `NonLeft` is the conversation list's definition of a conversation:
    // everything the user has not left, invitations included.
    const controller = subscription.controller();
    const accepted = controller.setFilter(new RoomListEntriesDynamicFilterKind.NonLeft());
    if (!accepted) {
      logger.error(`${LOG_TAG} the room list refused its filter; it will stay empty`);
      return;
    }
    // The first page is asked for rather than assumed. Setting a filter is
    // documented to reset the view to one page, but a room list that quietly
    // stays empty is indistinguishable from an account with no conversations, so
    // this does not lean on it.
    controller.resetToOnePage();
  }

  rooms(): readonly AlloRoomSummary[] {
    return this.#rooms;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stream?.cancel();
    this.#stream = undefined;
    this.#subscription = undefined;
    this.#onClose();
  }

  async #publish(generation: number, entries: readonly RoomLike[]): Promise<void> {
    if (this.#closed || generation !== this.#generation) {
      return;
    }
    try {
      const rooms = await this.#summaries.project(entries);
      if (this.#closed || generation !== this.#generation) {
        return;
      }
      this.#rooms = rooms;
      this.#onChange(rooms);
    } catch (error) {
      logger.error(`${LOG_TAG} room summaries could not be read`, error);
    }
  }
}

class NativeTimelineHandle implements AlloTimelineHandle {
  readonly #timeline: TimelineLike;
  readonly #onChange: (items: readonly AlloTimelineItem[]) => void;
  readonly #onClose: () => void;
  readonly #rows: TimelineItemLike[] = [];
  readonly #projection = new TimelineProjection();

  #items: readonly AlloTimelineItem[] = [];
  #stream: TaskHandleLike | undefined;
  #closed = false;

  constructor(
    timeline: TimelineLike,
    onChange: (items: readonly AlloTimelineItem[]) => void,
    onClose: () => void,
  ) {
    this.#timeline = timeline;
    this.#onChange = onChange;
    this.#onClose = onClose;
  }

  async attach(): Promise<void> {
    this.#stream = await this.#timeline.addListener({
      onUpdate: (diffs: TimelineDiff[]): void => {
        try {
          for (const diff of diffs) {
            applyListUpdate(this.#rows, diff);
          }
        } catch (error) {
          logger.error(`${LOG_TAG} timeline update could not be applied`, error);
          return;
        }
        this.#items = this.#projection.project(this.#rows);
        this.#onChange(this.#items);
      },
    });
  }

  items(): readonly AlloTimelineItem[] {
    return this.#items;
  }

  async paginateBackwards(count: number): Promise<AlloPaginationOutcome> {
    const reachedStart = await this.#timeline.paginateBackwards(count);
    return reachedStart ? 'reached-start' : 'more-available';
  }

  async sendText(body: string): Promise<void> {
    // `messageEventContentNew` and not `messageEventContentFromMarkdown`: what the
    // user typed is text. Running it through a markdown parser would turn their
    // asterisks into formatting they did not ask for.
    await this.#timeline.send(
      messageEventContentNew(new MessageType.Text({ content: { body } })),
    );
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stream?.cancel();
    this.#stream = undefined;
    this.#onClose();
  }
}

function toAlloSession(session: Session): AlloSession {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
  };
}

/**
 * The SDK's session carries two fields the port does not.
 *
 * `oidcData` is left out because `matrix-js-sdk` has no equivalent and this port
 * only logs in with a password. A session obtained through OIDC must not be round
 * tripped through {@link AlloSession}: it would lose what its token refresh
 * depends on.
 *
 * `slidingSyncVersion` is restored as `Native` rather than carried, because
 * `Native` is the only value a working Allo session can have: the client is built
 * with `DiscoverNative`, and a homeserver that does not serve native sliding sync
 * fails at `build()` long before there is a session to restore.
 */
function toSdkSession(session: AlloSession): Session {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    oidcData: undefined,
    slidingSyncVersion: SlidingSyncVersion.Native,
  };
}
