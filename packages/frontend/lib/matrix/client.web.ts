import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  ClientEvent,
  EventTimeline,
  EventType,
  IndexedDBStore,
  MatrixError,
  MatrixEventEvent,
  MemoryStore,
  MsgType,
  OAuth2,
  RoomEvent,
  RoomStateEvent,
  TokenRefresher,
  createClient,
  isValidAuthMetadata,
} from 'matrix-js-sdk';
import type {
  AccessTokens,
  MatrixClient,
  MatrixEvent,
  Room,
  Store,
  SyncState,
  ValidatedAuthMetadata,
} from 'matrix-js-sdk';

import {
  MatrixNotLoggedInError,
  MatrixOidcCallbackError,
  MatrixRoomNotFoundError,
  MatrixSessionAlreadyStartedError,
  MatrixSessionRestoreError,
  MatrixStoreUnavailableError,
  MatrixSyncNotStartedError,
} from '@/lib/matrix/errors';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloEncryptionState,
  AlloOidcLoginOptions,
  AlloOidcLoginRequest,
  AlloPaginationOutcome,
  AlloRoomListHandle,
  AlloRoomSummary,
  AlloSession,
  AlloSyncState,
  AlloTimelineHandle,
  AlloTimelineItem,
  AlloUnsubscribe,
} from '@/lib/matrix/types';
import { logger } from '@/utils/logger';

import { Coalescer } from './web/coalesce';
import { CryptoWasmLoader } from './web/cryptoWasm';
import {
  WebOidcLoginRequest,
  generateAuthorizationState,
  type OidcGrant,
} from './web/oidcLogin';
import { directRoomIds, orderRoomList, type RoomListEntry } from './web/roomList';
import { decodeAuthData, encodeAuthData } from './web/session';
import { toEncryptionState, toRoomSummary, toSyncState, toTimelineItem } from './web/translate';

/**
 * The web implementation of the Allo chat port, over `matrix-js-sdk` and the Rust
 * crypto machine compiled to WebAssembly.
 *
 * Metro serves this file on web and `client.native.ts` on iOS and Android. The
 * contract both answer to is in `lib/matrix/types.ts`, and it is the contract that
 * is shared — not the code, and deliberately not the timeline: the two SDKs have
 * opposite models, one a stream of diffs over a list Rust maintains and the other
 * a graph of mutable objects that emit events, and unifying them would mean
 * reimplementing one on top of the other. See `docs/matrix/client-strategy.md`
 * §2.3.
 *
 * Three things about this half differ from the native one on purpose:
 *
 * - **No sliding sync.** `matrix-js-sdk` implements MSC4186 but marks it
 *   experimental, while the ordinary `/sync` works against any homeserver. The
 *   asymmetry is documented and accepted (§2.1): native *requires* a homeserver
 *   serving native sliding sync, web requires nothing.
 * - **No send queue.** The Rust SDK's offline send queue has no equivalent here.
 *   A browser tab that is closed retries nothing anyway, so Allo on web has worse
 *   offline behaviour than Allo on a phone (§2.4).
 * - **Login is done by hand.** The binding's `loginWithOidcCallback` exchanges the
 *   authorization code and installs the session in one call; here the exchange,
 *   the `state` check and the device identity are this file's job. See
 *   `web/oidcLogin.ts`.
 *
 * **What is missing, and is not hidden by anything below: two tabs are unsafe.**
 * The SDK's own words on `initRustCrypto` are that "the cryptography stack is not
 * thread-safe. Having multiple `MatrixClient` instances connected to the same
 * Indexed DB will cause data corruption and decryption failures", and two tabs of
 * Allo are exactly two clients on one IndexedDB. The spike could not force the
 * corruption in minutes of trying (`spikes/matrix-web/RESULTS.md`), but the
 * warning describes a race and a race is not disproved by not seeing it. What is
 * absent here is the lock that would make the second tab wait or refuse:
 * `navigator.locks` and `SharedWorker` both exist in the runtime, neither is
 * used, and nothing in this file notices a second tab. Until that is built, Allo
 * on web is safe in one tab and untested in two.
 */

const LOG_TAG = '[matrix]';

/**
 * How many messages per room the first sync brings back.
 *
 * Enough to draw a conversation without paginating, small enough that opening the
 * app is not a download. Older messages come from `paginateBackwards`.
 */
const INITIAL_SYNC_LIMIT = 20;

/** `m.room.encryption` is room state with an empty state key. */
const ENCRYPTION_STATE_KEY = '';

export const createAlloChatClient: AlloChatClientFactory = async (config) =>
  new WebAlloChatClient(config);

class WebAlloChatClient implements AlloChatClient {
  readonly #config: AlloChatClientConfig;
  /**
   * The crypto module is loaded through this and nowhere else, which is what
   * keeps 7.8 MB off the login screen. See `web/cryptoWasm.ts` for why the URL is
   * explicit and why the load happens where it does.
   */
  readonly #wasm = new CryptoWasmLoader(initAsync);
  readonly #syncStateListeners = new Set<(state: AlloSyncState) => void>();
  readonly #roomLists = new Set<WebRoomListHandle>();
  readonly #timelines = new Set<WebTimelineHandle>();

  #client: MatrixClient | undefined;
  #session: AlloSession | undefined;
  #syncState: AlloSyncState = 'idle';
  #syncing = false;
  #watchingSyncState = false;

  constructor(config: AlloChatClientConfig) {
    this.#config = config;
  }

  async beginOidcLogin(options: AlloOidcLoginOptions = {}): Promise<AlloOidcLoginRequest> {
    this.#requireNoSession('start a login');

    const metadata = await createClient({
      baseUrl: this.#config.homeserverUrl,
    }).getAuthMetadata();
    const clientId = await this.#resolveClientId(metadata);

    const authorization = new OAuth2(metadata, {
      clientId,
      redirectUri: this.#config.oidc.redirectUri,
      // Left unset, the SDK mints one. Under OIDC the device id is the client's
      // to choose — it travels in the requested scope — and it is what this
      // installation's encryption keys hang off.
      deviceId: options.deviceId,
    });

    const state = generateAuthorizationState();
    const authorizationUrl = await this.#buildAuthorizationUrl(authorization, state, options);

    return new WebOidcLoginRequest(authorization, authorizationUrl, state, (grant) =>
      this.#startFromGrant(grant, authorization, metadata, clientId),
    );
  }

  async restoreSession(session: AlloSession): Promise<void> {
    this.#requireNoSession('restore a session');

    const authData = decodeAuthData(session.authData);
    if (!isValidAuthMetadata(authData.authMetadata)) {
      throw new MatrixSessionRestoreError(
        'the authorization server metadata it carries is not valid',
      );
    }

    await this.#start(
      session,
      new OAuth2(authData.authMetadata, {
        clientId: authData.clientId,
        redirectUri: authData.redirectUri,
        deviceId: session.deviceId,
      }),
    );
  }

  session(): AlloSession {
    if (this.#session === undefined) {
      throw new MatrixNotLoggedInError('Reading the session');
    }
    return this.#session;
  }

  async startSync(): Promise<void> {
    const client = this.#requireClient('Starting the sync loop');
    this.#watchSyncState(client);
    await client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
    // Only once the loop is actually up: a `startClient` that threw leaves a
    // client that would report "the room list is empty" where it should report
    // that there is no sync to observe.
    this.#syncing = true;
  }

  async stopSync(): Promise<void> {
    this.#syncing = false;
    this.#client?.stopClient();
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
    const client = this.#requireSyncing('Observing the room list');
    const handle = new WebRoomListHandle(client, onChange, () => {
      this.#roomLists.delete(handle);
    });
    this.#roomLists.add(handle);
    handle.attach();
    return handle;
  }

  async roomEncryption(roomId: string): Promise<AlloEncryptionState> {
    const room = this.#requireRoom(roomId, "Reading a room's encryption state");
    const client = this.#requireClient("Reading a room's encryption state");

    const local = toEncryptionState(room, room.getLiveTimeline().getState(EventTimeline.FORWARDS));
    if (local !== 'unknown') {
      return local;
    }

    // Sync has not delivered this room's state, so ask the server rather than
    // reporting the room as unencrypted — which is the false negative the UI
    // would draw as an open padlock.
    try {
      const content = await client.getStateEvent(
        roomId,
        EventType.RoomEncryption,
        ENCRYPTION_STATE_KEY,
      );
      return typeof content.algorithm === 'string' ? 'encrypted' : 'unencrypted';
    } catch (error) {
      if (error instanceof MatrixError) {
        // The room genuinely has no encryption event.
        if (error.errcode === 'M_NOT_FOUND') {
          return 'unencrypted';
        }
        // Not allowed to read the room's state — a room the viewer has left, or
        // an invitation whose stripped state did not include it. "Not allowed to
        // know" is not "not encrypted".
        if (error.errcode === 'M_FORBIDDEN') {
          return 'unknown';
        }
      }
      throw error;
    }
  }

  async openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle> {
    const client = this.#requireSyncing('Opening a timeline');
    const room = this.#requireRoom(roomId, 'Opening a timeline');
    const handle = new WebTimelineHandle(client, room, onChange, () => {
      this.#timelines.delete(handle);
    });
    this.#timelines.add(handle);
    handle.attach();
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

    const client = this.#client;
    if (client !== undefined && this.#watchingSyncState) {
      client.off(ClientEvent.Sync, this.#onSyncState);
      this.#watchingSyncState = false;
    }
    this.#syncing = false;
    this.#syncState = 'idle';
    client?.stopClient();
  }

  /**
   * The authorization URL, plus the one parameter the SDK does not build.
   *
   * `generateAuthorizationCodeGrantUrl` covers PKCE, the scope that carries the
   * device id, and the prompt, but has no argument for `login_hint` — an ordinary
   * OpenID Connect parameter that MSC4198 gives a Matrix meaning. Adding it to
   * the finished URL is a smaller thing to own than a fork of the URL builder.
   */
  async #buildAuthorizationUrl(
    authorization: OAuth2,
    state: string,
    options: AlloOidcLoginOptions,
  ): Promise<string> {
    const url = new URL(
      await authorization.generateAuthorizationCodeGrantUrl(state, undefined, options.prompt),
    );
    if (options.loginHint !== undefined) {
      url.searchParams.set('login_hint', options.loginHint);
    }
    return url.toString();
  }

  /**
   * The client id Allo authorizes as: agreed in advance where the deployment says
   * so, and registered on the spot where it does not.
   */
  async #resolveClientId(metadata: ValidatedAuthMetadata): Promise<string> {
    const registrations = this.#config.oidc.staticRegistrations;
    const configured =
      registrations?.get(metadata.issuer) ?? registrations?.get(this.#config.homeserverUrl);
    if (configured !== undefined) {
      return configured;
    }

    return OAuth2.registerClient(metadata, {
      client_name: this.#config.oidc.clientName,
      client_uri: this.#config.oidc.clientUri,
      logo_uri: this.#config.oidc.logoUri,
      tos_uri: this.#config.oidc.tosUri,
      policy_uri: this.#config.oidc.policyUri,
      redirect_uris: [this.#config.oidc.redirectUri],
      application_type: 'web',
    });
  }

  async #startFromGrant(
    grant: OidcGrant,
    authorization: OAuth2,
    metadata: ValidatedAuthMetadata,
    clientId: string,
  ): Promise<AlloSession> {
    // The device the token is actually bound to, asked of the homeserver rather
    // than assumed from the scope that was requested. An authorization server
    // that ignored the requested device id would otherwise leave this client
    // keeping its keys under an identity that does not exist.
    const identity = await createClient({
      baseUrl: this.#config.homeserverUrl,
      accessToken: grant.accessToken,
    }).whoami();
    if (identity.device_id === undefined) {
      throw new MatrixOidcCallbackError(
        'the homeserver issued a session with no device id, and a session with no ' +
          'device cannot hold encryption keys',
      );
    }
    if (identity.device_id !== grant.deviceId) {
      logger.warn(
        `${LOG_TAG} the homeserver bound this session to device ${identity.device_id}, ` +
          `not the requested ${grant.deviceId}`,
      );
    }

    await this.#start(
      {
        userId: identity.user_id,
        deviceId: identity.device_id,
        homeserverUrl: this.#config.homeserverUrl,
        accessToken: grant.accessToken,
        refreshToken: grant.refreshToken,
        authData: encodeAuthData({
          clientId,
          redirectUri: this.#config.oidc.redirectUri,
          authMetadata: metadata,
        }),
      },
      authorization,
    );

    return this.session();
  }

  /**
   * Brings the client up around a session: store, tokens, crypto.
   *
   * The order is the one constraint that is not negotiable. The WebAssembly has
   * to be loaded before `initRustCrypto`, because the SDK calls the package's
   * `initAsync` with no URL of its own and whichever call happens first decides
   * where the module is fetched from — and the SDK's default resolves to a path
   * the web export does not contain.
   */
  async #start(session: AlloSession, authorization: OAuth2): Promise<void> {
    this.#requireNoSession('start a session');

    const store = this.#createStore();
    await store.startup();

    const refresher = new TokenRefresher(authorization, async (tokens) => {
      this.#onTokensRefreshed(tokens);
    });

    const client = createClient({
      baseUrl: session.homeserverUrl,
      userId: session.userId,
      deviceId: session.deviceId,
      accessToken: session.accessToken,
      refreshToken: session.refreshToken,
      tokenRefreshFunction: refresher.tokenRefreshFunction,
      store,
      // Allo's calls do not go through Matrix, so the SDK has no reason to poll
      // the homeserver for TURN servers.
      disableVoip: true,
      // Left off on purpose. With improved timeline support the SDK stops
      // back-paginating the live timeline across a sync gap, and the live
      // timeline is exactly what `openTimeline` paginates.
      timelineSupport: false,
    });

    await this.#wasm.load();

    // The crypto store is keyed by device: a second device on this browser is a
    // second set of keys, and letting them share a store makes the SDK refuse to
    // open it at all. Nothing deletes the store of a device that is no longer
    // used — that belongs with a logout flow, which this port does not have.
    //
    // This is also the call the SDK's multi-tab warning is attached to; see the
    // note at the top of this file for what is not being done about it.
    await client.initRustCrypto(
      this.#config.store.kind === 'in-memory'
        ? { useIndexedDB: false }
        : {
            useIndexedDB: true,
            cryptoDatabasePrefix: `${this.#config.store.dataPath}:${session.deviceId}`,
          },
    );

    this.#client = client;
    this.#session = session;
    this.#watchSyncState(client);
  }

  /**
   * Where the client keeps its state.
   *
   * The port's store shape comes from the native half, where it is two
   * filesystem paths. A browser has no filesystem: `dataPath` names the IndexedDB
   * database instead, so two different paths stay two different stores, and
   * `cachePath` has nothing to name and is unused.
   */
  #createStore(): Store {
    if (this.#config.store.kind === 'in-memory') {
      return new MemoryStore();
    }

    const indexedDB: IDBFactory | undefined = globalThis.indexedDB;
    if (indexedDB === undefined) {
      throw new MatrixStoreUnavailableError(
        'this browser exposes no IndexedDB, so there is nowhere to keep the ' +
          "device's encryption keys. Private browsing modes and some embedded " +
          'webviews refuse it.',
      );
    }
    return new IndexedDBStore({ indexedDB, dbName: this.#config.store.dataPath });
  }

  /**
   * The SDK rotates the session's tokens on its own, and under OIDC it does so
   * often. The port has no way to tell the app that it happened — the same gap
   * the native half has, documented on {@link AlloSession} — so the best that can
   * be done here is keep {@link session} answering with the current tokens, so an
   * app that reads it again gets something worth persisting.
   */
  #onTokensRefreshed(tokens: AccessTokens): void {
    const session = this.#session;
    if (session === undefined) {
      return;
    }
    this.#session = {
      ...session,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
    // Never the tokens themselves: they are credentials.
    logger.info(`${LOG_TAG} the session's tokens were refreshed`);
  }

  #watchSyncState(client: MatrixClient): void {
    if (this.#watchingSyncState) {
      return;
    }
    this.#watchingSyncState = true;
    client.on(ClientEvent.Sync, this.#onSyncState);
  }

  readonly #onSyncState = (state: SyncState): void => {
    this.#syncState = toSyncState(state);
    for (const listener of this.#syncStateListeners) {
      listener(this.#syncState);
    }
  };

  #requireNoSession(attempted: string): void {
    if (this.#client !== undefined) {
      throw new MatrixSessionAlreadyStartedError(attempted);
    }
  }

  #requireClient(operation: string): MatrixClient {
    if (this.#client === undefined) {
      throw new MatrixNotLoggedInError(operation);
    }
    return this.#client;
  }

  #requireSyncing(operation: string): MatrixClient {
    const client = this.#requireClient(operation);
    if (!this.#syncing) {
      throw new MatrixSyncNotStartedError(operation);
    }
    return client;
  }

  #requireRoom(roomId: string, operation: string): Room {
    // Rooms come from the store, which is what sync fills: without it the client
    // knows no rooms at all, and reporting that as "no such room" would send the
    // caller looking for the wrong problem.
    const room = this.#requireSyncing(operation).getRoom(roomId);
    if (room === null) {
      throw new MatrixRoomNotFoundError(roomId);
    }
    return room;
  }
}

class WebRoomListHandle implements AlloRoomListHandle {
  readonly #client: MatrixClient;
  readonly #onChange: (rooms: readonly AlloRoomSummary[]) => void;
  readonly #onClose: () => void;
  readonly #coalescer: Coalescer;

  #rooms: readonly AlloRoomSummary[] = [];
  #closed = false;

  constructor(
    client: MatrixClient,
    onChange: (rooms: readonly AlloRoomSummary[]) => void,
    onClose: () => void,
  ) {
    this.#client = client;
    this.#onChange = onChange;
    this.#onClose = onClose;
    this.#coalescer = new Coalescer(() => {
      this.#publish();
    });
  }

  /**
   * Everything that can change a row of the conversation list.
   *
   * The client re-emits its rooms' events, so one subscription covers every room,
   * including rooms that do not exist yet. Each of these is a rebuild rather than
   * a targeted update because the list is republished whole — and because a
   * targeted update would have to know that a message in one room reorders every
   * row below it.
   */
  attach(): void {
    this.#client.on(ClientEvent.Room, this.#schedule);
    this.#client.on(ClientEvent.DeleteRoom, this.#schedule);
    // `m.direct` is what makes a room a direct message.
    this.#client.on(ClientEvent.AccountData, this.#schedule);
    // Every sync response, which is the only signal for the one field no
    // narrower event carries to the client: the unread count. `Room` emits
    // `UnreadNotifications` but the client does not re-emit it, and a badge
    // cleared by the user reading on their phone arrives with nothing else
    // attached. Coalesced with the rest, so an idle poll costs one rebuild.
    this.#client.on(ClientEvent.Sync, this.#schedule);
    this.#client.on(RoomEvent.Name, this.#schedule);
    this.#client.on(RoomEvent.Timeline, this.#schedule);
    this.#client.on(RoomEvent.MyMembership, this.#schedule);
    this.#client.on(RoomEvent.Receipt, this.#schedule);
    // Avatars, and the encryption state that decides the padlock.
    this.#client.on(RoomStateEvent.Events, this.#schedule);

    // Published rather than left empty until something moves: sync may have
    // finished before this handle was opened, in which case no event is coming.
    this.#publish();
  }

  rooms(): readonly AlloRoomSummary[] {
    return this.#rooms;
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#coalescer.cancel();

    this.#client.off(ClientEvent.Room, this.#schedule);
    this.#client.off(ClientEvent.DeleteRoom, this.#schedule);
    this.#client.off(ClientEvent.AccountData, this.#schedule);
    this.#client.off(ClientEvent.Sync, this.#schedule);
    this.#client.off(RoomEvent.Name, this.#schedule);
    this.#client.off(RoomEvent.Timeline, this.#schedule);
    this.#client.off(RoomEvent.MyMembership, this.#schedule);
    this.#client.off(RoomEvent.Receipt, this.#schedule);
    this.#client.off(RoomStateEvent.Events, this.#schedule);

    this.#onClose();
  }

  readonly #schedule = (): void => {
    this.#coalescer.schedule();
  };

  #publish(): void {
    if (this.#closed) {
      return;
    }

    const direct = directRoomIds(this.#client.getAccountData(EventType.Direct)?.getContent());
    const entries: RoomListEntry[] = [];

    // `getVisibleRooms` and not `getRooms`: it drops the old versions of rooms
    // that have been upgraded, which are rooms the user has already been moved
    // out of.
    for (const room of this.#client.getVisibleRooms()) {
      const summary = toRoomSummary(
        room,
        room.getLiveTimeline().getState(EventTimeline.FORWARDS),
        direct.has(room.roomId),
      );
      if (summary === undefined) {
        logger.warn(
          `${LOG_TAG} room ${room.roomId} has membership "${room.getMyMembership()}", ` +
            'which this version of Allo cannot draw',
        );
        continue;
      }
      // Everything the user has not left, invitations included: the same
      // definition of a conversation the native half gets from the Rust SDK's
      // `NonLeft` filter.
      if (summary.membership === 'left') {
        continue;
      }
      entries.push({ summary, activityTimestamp: room.getLastActiveTimestamp() });
    }

    this.#rooms = orderRoomList(entries);
    this.#onChange(this.#rooms);
  }
}

class WebTimelineHandle implements AlloTimelineHandle {
  readonly #client: MatrixClient;
  readonly #room: Room;
  readonly #onChange: (items: readonly AlloTimelineItem[]) => void;
  readonly #onClose: () => void;
  readonly #coalescer: Coalescer;

  #items: readonly AlloTimelineItem[] = [];
  #closed = false;

  constructor(
    client: MatrixClient,
    room: Room,
    onChange: (items: readonly AlloTimelineItem[]) => void,
    onClose: () => void,
  ) {
    this.#client = client;
    this.#room = room;
    this.#onChange = onChange;
    this.#onClose = onClose;
    this.#coalescer = new Coalescer(() => {
      this.#publish();
    });
  }

  attach(): void {
    this.#client.on(RoomEvent.Timeline, this.#onRoomChanged);
    // A gappy sync replaces the live timeline object outright, which is why
    // nothing here holds on to one.
    this.#client.on(RoomEvent.TimelineReset, this.#onTimelineReset);
    this.#client.on(RoomEvent.LocalEchoUpdated, this.#onRoomChanged);
    this.#client.on(RoomEvent.Redaction, this.#onRoomChanged);
    // A room key arriving turns an unreadable row into a readable one.
    this.#client.on(MatrixEventEvent.Decrypted, this.#onEventChanged);
    this.#client.on(MatrixEventEvent.Replaced, this.#onEventChanged);

    this.#publish();
  }

  items(): readonly AlloTimelineItem[] {
    return this.#items;
  }

  async paginateBackwards(count: number): Promise<AlloPaginationOutcome> {
    // The live timeline is read again rather than remembered: a sync gap can have
    // replaced it since the last call.
    const more = await this.#client.paginateEventTimeline(this.#room.getLiveTimeline(), {
      backwards: true,
      limit: count,
    });
    this.#coalescer.schedule();
    return more ? 'more-available' : 'reached-start';
  }

  async sendText(body: string): Promise<void> {
    // Sent as text, verbatim. Running it through a markdown parser would turn the
    // user's asterisks into formatting they did not ask for.
    await this.#client.sendMessage(this.#room.roomId, { msgtype: MsgType.Text, body });
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#coalescer.cancel();

    this.#client.off(RoomEvent.Timeline, this.#onRoomChanged);
    this.#client.off(RoomEvent.TimelineReset, this.#onTimelineReset);
    this.#client.off(RoomEvent.LocalEchoUpdated, this.#onRoomChanged);
    this.#client.off(RoomEvent.Redaction, this.#onRoomChanged);
    this.#client.off(MatrixEventEvent.Decrypted, this.#onEventChanged);
    this.#client.off(MatrixEventEvent.Replaced, this.#onEventChanged);

    this.#onClose();
  }

  readonly #onRoomChanged = (_event: unknown, room?: Room): void => {
    this.#scheduleIfMine(room);
  };

  /** `TimelineReset` reports the room first: there is no event to report. */
  readonly #onTimelineReset = (room?: Room): void => {
    this.#scheduleIfMine(room);
  };

  /**
   * An event with no room attached is one the SDK could not place. Rebuilding on
   * it costs a pass over one already-loaded timeline; ignoring it risks a row
   * that never appears.
   */
  #scheduleIfMine(room: Room | undefined): void {
    if (room === undefined || room.roomId === this.#room.roomId) {
      this.#coalescer.schedule();
    }
  }

  readonly #onEventChanged = (event: MatrixEvent): void => {
    if (event.getRoomId() === this.#room.roomId) {
      this.#coalescer.schedule();
    }
  };

  #publish(): void {
    if (this.#closed) {
      return;
    }

    const viewerUserId = this.#client.getSafeUserId();
    const items: AlloTimelineItem[] = [];
    // Local echoes are in here too: the client is started with the SDK's default
    // chronological ordering, which puts a message in the timeline the moment it
    // is sent rather than in a list of its own.
    for (const event of this.#room.getLiveTimeline().getEvents()) {
      const item = toTimelineItem(event, viewerUserId);
      if (item === undefined) {
        logger.warn(
          `${LOG_TAG} an event in ${this.#room.roomId} has neither an event id nor a ` +
            'transaction id and cannot be drawn',
        );
        continue;
      }
      items.push(item);
    }

    this.#items = items;
    this.#onChange(this.#items);
  }
}
