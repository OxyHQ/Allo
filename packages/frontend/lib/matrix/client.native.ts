import { Directory, File, Paths } from 'expo-file-system';
import {
  ClientBuilder,
  EditedContent,
  EventOrTransactionId,
  LogLevel,
  MediaSource,
  Membership,
  MessageType,
  OidcPrompt,
  PushFormat,
  PusherKind,
  ReceiptType,
  RoomListEntriesDynamicFilterKind,
  SlidingSyncVersion,
  SlidingSyncVersionBuilder,
  initPlatform,
  messageEventContentNew,
} from '@unomed/react-native-matrix-sdk';
import type {
  ClientLike,
  EnableRecoveryProgress,
  EncryptionLike,
  OidcConfiguration,
  RoomLike,
  RoomListEntriesListener,
  RoomListEntriesUpdate,
  RoomListEntriesWithDynamicAdaptersResultLike,
  SendAttachmentJoinHandleLike,
  Session,
  SyncServiceLike,
  TaskHandleLike,
  TimelineDiff,
  TimelineItemLike,
  TimelineLike,
} from '@unomed/react-native-matrix-sdk';

import { soleDirectInvitee } from '@/lib/matrix/directMessage';
import { MatrixRoomNotFoundError, MatrixSyncNotStartedError } from '@/lib/matrix/errors';
// Named in full rather than as `@/lib/matrix/store`: this half of the port is
// the native one and its store is the native one, and saying so leaves no
// resolution rule to trust. The platform-resolved name is for the code above
// the split, which must not care.
import { eraseAlloChatStore } from '@/lib/matrix/store.native';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloClientStore,
  AlloCreateRoomRequest,
  AlloEncryptionState,
  AlloMediaFile,
  AlloMediaRef,
  AlloOidcClientMetadata,
  AlloOidcLoginOptions,
  AlloOidcLoginRequest,
  AlloOidcPrompt,
  AlloOutgoingAttachment,
  AlloPaginationOutcome,
  AlloPusher,
  AlloPusherIdentity,
  AlloRecoveryState,
  AlloRoomListHandle,
  AlloRoomSummary,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { toCreateRoomParameters } from './native/createRoom';
import { applyListUpdate } from './native/listDiff';
import {
  decodeMediaRef,
  toThumbnailInfo,
  toThumbnailSource,
  toUploadParameters,
} from './native/media';
import { NativeOidcLoginRequest } from './native/oidcLogin';
import { describeEnableRecoveryProgress, toRecoveryState } from './native/recovery';
import { RoomSummaryCache } from './native/roomSummaries';
import { TimelineProjection } from './native/timelineProjection';
import { NativeSessionDelegate, toAlloSession } from './native/session';
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
 * The memberships that make an existing direct message worth reopening.
 *
 * A room the user was invited to is one: accepting the invitation is how the
 * conversation continues, and inviting them to a second room instead leaves two.
 * A room they left, were kicked from or were banned from is not — `m.direct`
 * still names it, and the way back in is not to send another message into it.
 */
const REUSABLE_MEMBERSHIPS: ReadonlySet<Membership> = new Set([
  Membership.Joined,
  Membership.Invited,
]);

/**
 * Where downloaded attachments are put, inside the app's cache directory.
 *
 * A cache and not a document directory, because everything in it is a *copy* of
 * something the homeserver still holds and can be fetched again — and because
 * the decrypted copy of a picture from an encrypted conversation is the one
 * piece of Allo's data the system should be free to reclaim.
 */
const MEDIA_DIRECTORY = 'matrix-media';

/** Makes each downloaded file's name unique within a run. See {@link cacheFileName}. */
let mediaSequence = 0;

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
  // Built before the client because that is the only order the binding offers:
  // the delegate goes to the builder, and only afterwards is there a client for
  // it to read. See `native/session.ts`.
  const sessions = new NativeSessionDelegate();
  const client = await buildClient(config, sessions);
  sessions.bind(client);
  return new NativeAlloChatClient(
    client,
    toOidcConfiguration(config.oidc),
    config.store,
    sessions,
  );
};

async function buildClient(
  config: AlloChatClientConfig,
  sessions: NativeSessionDelegate,
): Promise<ClientLike> {
  const builder = new ClientBuilder()
    .homeserverUrl(config.homeserverUrl)
    // The binding's one way of reporting that it has rotated the session's
    // tokens. Without it a persisted session is a snapshot that goes stale the
    // first time the SDK refreshes, and every launch after that is a new login
    // and a new Matrix device.
    .setSessionDelegate(sessions)
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

/**
 * Allo asks for no prompt by default: the authorization server decides whether to
 * show a login screen or reuse the session the user already has with Oxy, which
 * is the point of putting Oxy upstream in the first place.
 */
const OIDC_PROMPTS: Record<AlloOidcPrompt, () => OidcPrompt> = {
  create: () => new OidcPrompt.Create(),
  login: () => new OidcPrompt.Login(),
  consent: () => new OidcPrompt.Consent(),
};

function toOidcConfiguration(metadata: AlloOidcClientMetadata): OidcConfiguration {
  return {
    clientName: metadata.clientName,
    redirectUri: metadata.redirectUri,
    clientUri: metadata.clientUri,
    logoUri: metadata.logoUri,
    tosUri: metadata.tosUri,
    policyUri: metadata.policyUri,
    staticRegistrations: new Map(metadata.staticRegistrations ?? []),
  };
}

class NativeAlloChatClient implements AlloChatClient {
  readonly #client: ClientLike;
  readonly #oidc: OidcConfiguration;
  readonly #store: AlloClientStore;
  readonly #sessions: NativeSessionDelegate;
  readonly #syncStateListeners = new Set<(state: AlloSyncState) => void>();
  readonly #roomLists = new Set<NativeRoomListHandle>();
  readonly #timelines = new Set<NativeTimelineHandle>();

  #sync: SyncServiceLike | undefined;
  #syncStateHandle: TaskHandleLike | undefined;
  #syncState: AlloSyncState = 'idle';
  #encryptionHandle: EncryptionLike | undefined;

  constructor(
    client: ClientLike,
    oidc: OidcConfiguration,
    store: AlloClientStore,
    sessions: NativeSessionDelegate,
  ) {
    this.#client = client;
    this.#oidc = oidc;
    this.#store = store;
    this.#sessions = sessions;
  }

  async beginOidcLogin(options: AlloOidcLoginOptions = {}): Promise<AlloOidcLoginRequest> {
    const authorizationData = await this.#client.urlForOidc(
      this.#oidc,
      options.prompt === undefined ? undefined : OIDC_PROMPTS[options.prompt](),
      options.loginHint,
      options.deviceId,
      // The scopes for API access and for the device id are always requested by
      // the SDK; Allo asks for nothing on top of them.
      undefined,
    );
    return new NativeOidcLoginRequest(this.#client, authorizationData);
  }

  async restoreSession(session: AlloSession): Promise<void> {
    await this.#client.restoreSession(toSdkSession(session));
  }

  session(): AlloSession {
    return toAlloSession(this.#client.session());
  }

  observeSession(onChange: (session: AlloSession) => void): AlloUnsubscribe {
    return this.#sessions.observe(onChange);
  }

  /**
   * Logs out on the homeserver, then takes the store with it.
   *
   * The order is not interchangeable. `logout()` needs a working client and a
   * live access token, so it goes first; the local state goes afterwards and goes
   * whatever the homeserver said, because a sign-out that leaves this device's
   * keys on the phone is not a sign-out. A homeserver that could not be reached
   * is a warning and not a failure — see {@link AlloChatClient.logout} for why
   * this cannot be reported by throwing.
   */
  async logout(): Promise<void> {
    try {
      await this.#client.logout();
    } catch (error) {
      logger.warn(
        `${LOG_TAG} the homeserver was not told about this sign-out; the session ` +
          'is gone from this device either way',
        error,
      );
    }
    // Before erasing, not after: closing stops the sync loop, and a sync loop
    // still running against a store that is being deleted writes into a
    // directory nothing leads to.
    await this.close();
    await eraseAlloChatStore(this.#store);
  }

  /**
   * Registers this device's pusher with the homeserver.
   *
   * `PushFormat.EventIdOnly` is the only value the binding has — the Rust enum
   * has exactly one variant — so on this platform the guarantee in
   * {@link AlloPusher} is enforced by the SDK itself and not only by us. The web
   * half has to state it, because `matrix-js-sdk` will happily register any
   * format string it is given.
   *
   * The fallback text travels as `default_payload`, which the homeserver echoes
   * back to the gateway inside `devices[].data` on every notification. It is a
   * JSON *string* here because that is what the binding takes; Rust parses it
   * into a JSON value before it reaches the wire.
   */
  async registerPusher(pusher: AlloPusher): Promise<void> {
    await this.#client.setPusher(
      { pushkey: pusher.pushkey, appId: pusher.appId },
      new PusherKind.Http({
        data: {
          url: pusher.gatewayUrl,
          format: PushFormat.EventIdOnly,
          defaultPayload: JSON.stringify(pusher.fallbackNotification),
        },
      }),
      pusher.appDisplayName,
      pusher.deviceDisplayName,
      // No profile tag: Allo has one set of push rules per account and nothing
      // that would select a different one per device.
      undefined,
      pusher.lang,
    );
  }

  async unregisterPusher(identity: AlloPusherIdentity): Promise<void> {
    await this.#client.deletePusher({ pushkey: identity.pushkey, appId: identity.appId });
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

  /**
   * Creates a conversation, or hands back the one that already exists.
   *
   * `getDmRoom` is the binding's own index of `m.direct`, and it answers for
   * rooms the user has left as well as ones they are in — a conversation somebody
   * walked out of is not one to reopen, so the membership is checked rather than
   * assumed.
   *
   * The parameters that are not the caller's — private, invite-only, encrypted —
   * are built by {@link toCreateRoomParameters}, which is where they can be
   * asserted on.
   */
  async createRoom(request: AlloCreateRoomRequest): Promise<string> {
    const invitee = soleDirectInvitee(request);
    if (invitee !== undefined) {
      const existing = this.#client.getDmRoom(invitee);
      if (existing !== undefined && REUSABLE_MEMBERSHIPS.has(existing.membership())) {
        return existing.id();
      }
    }

    const room = await this.#client.createRoom(toCreateRoomParameters(request));
    // The binding writes `m.direct` itself for a direct message with one invitee,
    // which is the same rule {@link soleDirectInvitee} states; the web half has to
    // do it by hand.
    return room;
  }

  /**
   * Joins an invited room.
   *
   * The room is asked rather than the client: `Room.join()` acts on the room the
   * invitation is for, where `joinRoomById` would ask the homeserver to resolve
   * an id this client has already resolved. The room being in the state store is
   * also what makes an invitation to a room this device has never heard of fail
   * as "no such room" rather than as a network error.
   */
  async acceptInvitation(roomId: string): Promise<void> {
    await this.#requireRoom(roomId, 'Accepting an invitation').join();
  }

  async declineInvitation(roomId: string): Promise<void> {
    await this.#requireRoom(roomId, 'Declining an invitation').leave();
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

  async recoveryState(): Promise<AlloRecoveryState> {
    const encryption = this.#encryption();
    // The binding starts the crypto stack in background tasks once a session is
    // installed, and `recoveryState()` answers `Unknown` until they have run.
    // Reading it without waiting is how a device that only needed to recover
    // decides it has nothing to do.
    await encryption.waitForE2eeInitializationTasks();
    return toRecoveryState(encryption.recoveryState());
  }

  async enableRecovery(passphrase: string): Promise<void> {
    // The return value is the 4S key in base58 — a second credential that opens
    // exactly what the passphrase opens. Allo derives its passphrase from the
    // Oxy identity and can produce it again at any time, so there is nothing to
    // show the user and nothing to keep. It is dropped here rather than stored
    // in a variable that someone later logs.
    await this.#encryption().enableRecovery(
      // Not waiting for every room key to reach the backup. On an account with
      // history that is minutes of uploading, and this call sits between a
      // finished sign-in and a usable app. The backup engine carries on in the
      // background either way; what the user is waiting for is 4S existing, and
      // that is done long before the upload is.
      false,
      passphrase,
      this.#recoveryProgress,
    );
  }

  async recoverWithPassphrase(passphrase: string): Promise<void> {
    // One call does what web needs three for: it opens 4S, takes the
    // cross-signing keys and the backup decryption key out of it, and imports
    // the room keys. The parameter is named `recoveryKey` and documented to
    // accept either form; a passphrase is what Allo has.
    await this.#encryption().recover(passphrase);
  }

  async openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle> {
    const room = this.#requireRoom(roomId, 'Opening a timeline');
    const timeline = await room.timeline();
    // The room travels with the timeline because two of the handle's operations
    // are the room's in the binding and not the timeline's: a typing notice is
    // about the conversation, not about any event in it.
    const handle = new NativeTimelineHandle(
      timeline,
      room,
      this.#client.userId(),
      onChange,
      () => {
        this.#timelines.delete(handle);
      },
    );
    await handle.attach();
    this.#timelines.add(handle);
    return handle;
  }

  /**
   * Fetches an attachment and puts it somewhere a view can read it.
   *
   * Three things happen here and each one is deliberate.
   *
   * `getMediaFile` streams and **decrypts**: the SDK downloads the blob, and
   * when the ref names media from an encrypted room it decrypts it with the key
   * that travelled inside the event. Nothing in JavaScript ever holds the
   * bytes, which is what keeps a video off the bridge.
   *
   * The file is then `persist`ed into a directory Allo owns, and the SDK's own
   * handle is dropped. That is not tidiness: the binding's handle deletes its
   * file when it is garbage collected, and nothing here can say when that is —
   * a picture would vanish from the screen at a moment decided by the
   * collector. Owning the file makes {@link AlloMediaFile.release} the only
   * thing that removes it.
   *
   * The name it lands under is built from a counter and the extension, never
   * from the sender's filename. A filename arrives from another device, over
   * the network, and a `../` in one is how a remote sender would write outside
   * this directory.
   */
  async downloadMedia(ref: AlloMediaRef): Promise<AlloMediaFile> {
    const { source, mimetype, filename } = decodeMediaRef(ref);
    const handle = await this.#client.getMediaFile(
      MediaSource.fromJson(source),
      filename,
      mimetype,
      // Cached, so scrolling past the same picture twice downloads it once.
      true,
      undefined,
    );

    const directory = new Directory(Paths.cache, MEDIA_DIRECTORY);
    directory.create({ intermediates: true, idempotent: true });
    mediaSequence += 1;
    const file = new File(directory, cacheFileName(mediaSequence, filename));

    if (!handle.persist(toStorePath(file.uri))) {
      throw new Error(
        `The attachment ${filename} was downloaded but could not be written to ` +
          "the app's cache directory.",
      );
    }

    return {
      uri: file.uri,
      release: () => {
        // Plaintext on a phone's disk. A picture from an encrypted conversation
        // that outlives the screen showing it is exactly what the encryption was
        // for, so this is not housekeeping.
        try {
          if (file.exists) {
            file.delete();
          }
        } catch (error) {
          logger.warn(`${LOG_TAG} a downloaded attachment could not be removed`, error);
        }
      },
    };
  }

  async close(): Promise<void> {
    for (const timeline of [...this.#timelines]) {
      timeline.close();
    }
    for (const roomList of [...this.#roomLists]) {
      roomList.close();
    }
    this.#syncStateListeners.clear();
    this.#sessions.releaseObservers();
    this.#syncStateHandle?.cancel();
    this.#syncStateHandle = undefined;
    this.#encryptionHandle = undefined;

    const sync = this.#sync;
    // Dropped, not merely stopped: the state listener is gone with it, and
    // keeping the stopped service would let a later startSync() bring sync back
    // up with nothing reporting its state.
    this.#sync = undefined;
    this.#syncState = 'idle';
    await sync?.stop();
  }

  /**
   * The encryption handle, built once.
   *
   * `encryption()` mints a new object across the FFI boundary on every call, and
   * the recovery path asks for it several times in a row.
   */
  #encryption(): EncryptionLike {
    this.#encryptionHandle ??= this.#client.encryption();
    return this.#encryptionHandle;
  }

  /**
   * Progress while 4S is being created.
   *
   * The translation is a separate, tested function because one of the variants
   * carries the recovery key: see `native/recovery.ts`.
   */
  readonly #recoveryProgress = {
    onUpdate: (progress: EnableRecoveryProgress): void => {
      const description = describeEnableRecoveryProgress(progress);
      if (description !== undefined) {
        logger.info(`${LOG_TAG} enabling recovery: ${description}`);
      }
    },
  };

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
  readonly #room: RoomLike;
  readonly #viewerUserId: string;
  readonly #onChange: (items: readonly AlloTimelineItem[]) => void;
  readonly #onClose: () => void;
  readonly #rows: TimelineItemLike[] = [];
  readonly #projection = new TimelineProjection();
  readonly #typingListeners = new Set<(userIds: readonly string[]) => void>();

  #items: readonly AlloTimelineItem[] = [];
  #stream: TaskHandleLike | undefined;
  #typingStream: TaskHandleLike | undefined;
  #closed = false;

  constructor(
    timeline: TimelineLike,
    room: RoomLike,
    viewerUserId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
    onClose: () => void,
  ) {
    this.#timeline = timeline;
    this.#room = room;
    this.#viewerUserId = viewerUserId;
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

  /**
   * Uploads an attachment and sends the event that points at it.
   *
   * **Nothing here decides whether to encrypt, and nothing here can get it
   * wrong.** These five calls read the room's encryption state inside Rust and
   * encrypt the bytes before they are uploaded when it is set; there is no
   * parameter to pass and no plaintext path to fall into. The web half has to
   * do it by hand, which is why `web/attachments.ts` exists and why it fails
   * closed. See `docs/matrix/ui-wiring.md` §7.
   */
  async sendAttachment(attachment: AlloOutgoingAttachment): Promise<void> {
    const parameters = toUploadParameters(attachment);
    const thumbnailSource = toThumbnailSource(attachment.thumbnail);
    const thumbnailInfo = toThumbnailInfo(attachment.thumbnail);
    const size = toU64(attachment.size);

    const sending = ((): SendAttachmentJoinHandleLike => {
      switch (attachment.kind) {
        case 'image':
          return this.#timeline.sendImage(parameters, thumbnailSource, {
            width: toU64(attachment.width),
            height: toU64(attachment.height),
            mimetype: attachment.mimetype,
            size,
            thumbnailInfo,
          });
        case 'video':
          return this.#timeline.sendVideo(parameters, thumbnailSource, {
            duration: attachment.durationMs,
            width: toU64(attachment.width),
            height: toU64(attachment.height),
            mimetype: attachment.mimetype,
            size,
            thumbnailInfo,
          });
        // Both arms send `m.audio`, and the difference between them is a marker
        // the binding does not let this file set: `sendVoiceMessage` demands a
        // waveform, and Allo's recorder samples no amplitudes. Inventing one
        // would draw a picture of audio that was never measured, so a recording
        // goes out as an ordinary audio attachment carrying its real duration.
        case 'audio':
        case 'voice':
          return this.#timeline.sendAudio(parameters, {
            duration: attachment.durationMs,
            mimetype: attachment.mimetype,
            size,
          });
        case 'file':
          return this.#timeline.sendFile(parameters, {
            mimetype: attachment.mimetype,
            size,
            thumbnailInfo,
          });
      }
    })();

    // The `join()` is what makes this promise mean anything: the call above
    // returns as soon as the upload has been *queued*, so without it the
    // composer would clear itself before a byte had left the phone.
    await sending.join();
  }

  async toggleReaction(eventId: string, key: string): Promise<void> {
    // One call for both directions: the binding looks up whether this account
    // already annotated the event and either sends or redacts accordingly.
    await this.#timeline.toggleReaction(toEventOrTransactionId(eventId), key);
  }

  async edit(eventId: string, body: string): Promise<void> {
    await this.#timeline.edit(
      toEventOrTransactionId(eventId),
      // Text for the same reason `sendText` is text: an edit is the user typing
      // again, and their asterisks are asterisks.
      new EditedContent.RoomMessage({
        content: messageEventContentNew(new MessageType.Text({ content: { body } })),
      }),
    );
  }

  async redact(eventId: string, reason: string | undefined): Promise<void> {
    await this.#timeline.redactEvent(toEventOrTransactionId(eventId), reason);
  }

  async sendReadReceipt(eventId: string): Promise<void> {
    // `Read` and not `ReadPrivate`: a read mark nobody else can see is one the
    // sender's own bubble could never draw, and drawing it is the point.
    await this.#timeline.sendReadReceipt(ReceiptType.Read, eventId);
  }

  async sendTypingNotice(isTyping: boolean): Promise<void> {
    await this.#room.typingNotice(isTyping);
  }

  observeTyping(onChange: (userIds: readonly string[]) => void): AlloUnsubscribe {
    this.#typingListeners.add(onChange);
    // Subscribed on the first listener rather than in `attach`, so a conversation
    // nobody is watching for typing costs no stream at all.
    this.#typingStream ??= this.#room.subscribeToTypingNotifications({
      call: (typingUserIds: string[]): void => {
        // The viewer's own typing comes back down sync on some homeservers, and
        // "you are typing" is not something to draw at the reader.
        const others = typingUserIds.filter((userId) => userId !== this.#viewerUserId);
        for (const listener of this.#typingListeners) {
          listener(others);
        }
      },
    });
    return () => {
      this.#typingListeners.delete(onChange);
      if (this.#typingListeners.size === 0) {
        this.#typingStream?.cancel();
        this.#typingStream = undefined;
      }
    };
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#stream?.cancel();
    this.#stream = undefined;
    this.#typingStream?.cancel();
    this.#typingStream = undefined;
    this.#typingListeners.clear();
    this.#onClose();
  }
}

/**
 * An event id in the shape the timeline addresses rows with.
 *
 * Always the `EventId` arm. The port's message operations take an event id and
 * nothing else — see `AlloTimelineHandle` — so the transaction id arm, which is
 * how the binding addresses a row still on its way out, is unreachable from here
 * by construction.
 */
function toEventOrTransactionId(eventId: string): EventOrTransactionId {
  return new EventOrTransactionId.EventId({ eventId });
}

/**
 * A `u64` field of the binding's media records, from a JavaScript number.
 *
 * `undefined` stays `undefined`, and so does anything that is not a positive
 * whole number: `BigInt(1.5)` throws, and a width of zero is a default some
 * client filled in rather than a measurement.
 */
function toU64(value: number | undefined): bigint | undefined {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? BigInt(value)
    : undefined;
}

/**
 * What a downloaded attachment is called on disk.
 *
 * **Nothing of the sender's filename reaches the path except its extension**,
 * and that is stripped to letters and digits. The name came from another
 * device over the network; a `../` or an absolute path in one is how a remote
 * sender would write outside the cache directory. The extension survives
 * because `expo-image` and `expo-video` pick a decoder from it.
 */
function cacheFileName(sequence: number, filename: string): string {
  const dot = filename.lastIndexOf('.');
  const extension =
    dot > 0 ? filename.slice(dot + 1).replace(/[^A-Za-z0-9]/g, '').slice(0, 8) : '';
  return extension === '' ? `${sequence}` : `${sequence}.${extension}`;
}

/**
 * The plain path the Rust SDK writes to, from the URI expo-file-system speaks.
 *
 * The same conversion `store.native.ts` does for the SQLite directories, for
 * the same reason: the binding takes operating system paths, and a URI's
 * percent-encoding has to come off before one becomes a path.
 */
function toStorePath(uri: string): string {
  return uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
}

/**
 * `slidingSyncVersion` is restored as `Native` rather than carried in the port,
 * because `Native` is the only value a working Allo session can have: the client
 * is built with `DiscoverNative`, and a homeserver that does not serve native
 * sliding sync fails at `build()` long before there is a session to restore.
 */
function toSdkSession(session: AlloSession): Session {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    oidcData: session.authData,
    slidingSyncVersion: SlidingSyncVersion.Native,
  };
}
