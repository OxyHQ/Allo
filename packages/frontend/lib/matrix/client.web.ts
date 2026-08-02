import { initAsync } from '@matrix-org/matrix-sdk-crypto-wasm';
import {
  ClientEvent,
  EventTimeline,
  EventType,
  IndexedDBStore,
  KnownMembership,
  MatrixError,
  MatrixEventEvent,
  MemoryStore,
  MsgType,
  OAuth2,
  Preset,
  ReceiptType,
  RelationType,
  RoomEvent,
  RoomMemberEvent,
  RoomStateEvent,
  TokenRefresher,
  Visibility,
  createClient,
  isValidAuthMetadata,
} from 'matrix-js-sdk';
// Not exported from the root of `matrix-js-sdk@42`, only from this path inside
// the package — which a future version may move. The spike found the same
// (`spikes/matrix-web/RESULTS.md`, constraint 3). Depending on an internal path
// beats reimplementing PBKDF2, which would have to agree byte for byte with what
// Rust computes on the other platform.
import { deriveRecoveryKeyFromPassphrase } from 'matrix-js-sdk/lib/crypto-api/index.js';
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
  MatrixBackupExistsOnServerError,
  MatrixCryptoUnavailableError,
  MatrixMediaUnreadableError,
  MatrixNotLoggedInError,
  MatrixOidcCallbackError,
  MatrixRoomNotFoundError,
  MatrixSessionAlreadyStartedError,
  MatrixSessionRestoreError,
  MatrixStoreUnavailableError,
  MatrixSyncNotStartedError,
} from '@/lib/matrix/errors';
// Named in full rather than as `@/lib/matrix/store`: this half of the port is
// the web one and its store is the web one, and saying so leaves no resolution
// rule to trust. The platform-resolved name is for the code above the split,
// which must not care.
import { soleDirectInvitee } from '@/lib/matrix/directMessage';
import { cryptoDatabasePrefix } from '@/lib/matrix/store.web';
import { markReadByOthers } from '@/lib/matrix/readReceipts';
import type {
  AlloChatClient,
  AlloChatClientConfig,
  AlloChatClientFactory,
  AlloCreateRoomRequest,
  AlloEncryptionState,
  AlloMediaFile,
  AlloMediaRef,
  AlloReaction,
  AlloOidcLoginOptions,
  AlloOidcLoginRequest,
  AlloOutgoingAttachment,
  AlloPaginationOutcome,
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

import {
  decodeMediaRef,
  encryptionInfoOf,
  mxcUriOf,
  resolveAttachmentSource,
  toAttachmentContent,
  type OutgoingThumbnailSource,
} from './web/attachments';
import { Coalescer } from './web/coalesce';
import { CryptoWasmLoader } from './web/cryptoWasm';
import {
  decryptAttachment,
  encryptAttachment,
  readAttachmentBytes,
  toObjectUrl,
} from './web/mediaTransfer';
import {
  WebOidcLoginRequest,
  generateAuthorizationState,
  type OidcGrant,
} from './web/oidcLogin';
import { planKeyBackup, toRecoveryState } from './web/recovery';
import {
  directRoomIds,
  directRoomsWith,
  orderRoomList,
  selectRoomPreview,
  withDirectRoom,
  type RoomListEntry,
} from './web/roomList';
import { createSecretStorageKeyCallback } from './web/secretStorage';
import { decodeAuthData, encodeAuthData } from './web/session';
import {
  isTimelineRow,
  toEncryptionState,
  toReactions,
  toReaders,
  toRoomSummary,
  toSyncState,
  toTimelineItem,
} from './web/translate';

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

/**
 * The only encryption algorithm Matrix defines for rooms, spelled out because
 * `matrix-js-sdk@42` does not export a constant for it from its root.
 */
const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';

/**
 * How long the homeserver keeps this browser's typing notice alive.
 *
 * Longer than the composer's re-emit interval, so a user typing steadily never
 * flickers, and short enough that a tab closed mid-sentence stops claiming to be
 * typing within a few seconds. There is nothing to clean up on the way out: the
 * server forgets it on its own, which is the only cleanup a closed tab gets.
 */
const TYPING_NOTICE_TIMEOUT_MS = 10_000;

/**
 * What an edit's `body` is prefixed with for clients that cannot aggregate.
 *
 * The convention the spec suggests and every client follows: a receiver that does
 * not understand `m.replace` shows the fallback body, and the leading `* ` is
 * what tells its reader they are looking at a correction. Clients that do
 * understand it — including both halves of this port — read `m.new_content`
 * instead and never show the prefix.
 */
const EDIT_FALLBACK_PREFIX = ' * ';

/** Shared by every row nobody has reacted to, which is nearly all of them. */
const NO_REACTIONS: readonly AlloReaction[] = [];

/**
 * The SDK's crypto surface. Taken off the client rather than imported, because
 * `matrix-js-sdk@42` does not export `CryptoApi` from its root.
 */
type WebCryptoApi = NonNullable<ReturnType<MatrixClient['getCrypto']>>;

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
  readonly #sessionListeners = new Set<(session: AlloSession) => void>();
  readonly #roomLists = new Set<WebRoomListHandle>();
  readonly #timelines = new Set<WebTimelineHandle>();

  #client: MatrixClient | undefined;
  #session: AlloSession | undefined;
  #syncState: AlloSyncState = 'idle';
  #syncing = false;
  #watchingSyncState = false;
  /**
   * The 4S passphrase, for as long as this client exists.
   *
   * Held rather than passed, because the SDK does not take it as an argument: it
   * calls back for the secret storage key whenever it needs one, including long
   * after the recovery call that set this returned — a secret shared by another
   * device mid-session arrives that way. A callback that could only answer
   * during `enableRecovery` would leave those requests unanswered.
   *
   * It is a credential, and this is the honest account of what that means here.
   * It is never logged, never persisted and never sent anywhere; it is dropped
   * on {@link close}. It is *not* wiped: JavaScript strings cannot be
   * overwritten, so unlike the native binding — which zeroes its copy after
   * PBKDF2 — this holds a string until the garbage collector gets to it. What
   * bounds the exposure is not this field but where the value comes from: it is
   * derived from the Oxy phrase, which is already on the device, so an attacker
   * who can read this process's memory had the input to it either way.
   */
  #recoveryPassphrase: string | undefined;

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

  observeSession(onChange: (session: AlloSession) => void): AlloUnsubscribe {
    this.#sessionListeners.add(onChange);
    return () => {
      this.#sessionListeners.delete(onChange);
    };
  }

  /**
   * Logs out on the homeserver, then deletes every database this session used.
   *
   * `clearStores` is the SDK's own answer and covers both halves — the synced
   * state and the Rust crypto machine's two databases — but only if it is given
   * the same `cryptoDatabasePrefix` the client was started with. Given the wrong
   * one it deletes nothing, reports success, and leaves this device's keys in the
   * browser, which is why the prefix is built in one place by
   * {@link cryptoDatabasePrefix} rather than spelled out at each end.
   *
   * It also refuses to run while the client is running, which is why closing
   * comes in between rather than being left to `logout(true)`: a homeserver call
   * that threw would otherwise stop nothing and the stores would survive the
   * sign-out.
   */
  async logout(): Promise<void> {
    const client = this.#requireClient('Signing out');
    const session = this.#session;

    try {
      await client.logout(true);
    } catch (error) {
      logger.warn(
        `${LOG_TAG} the homeserver was not told about this sign-out; the session ` +
          'is gone from this browser either way',
        error,
      );
    }

    await this.close();
    await client.clearStores(
      this.#config.store.kind === 'in-memory' || session === undefined
        ? {}
        : {
            cryptoDatabasePrefix: cryptoDatabasePrefix(
              this.#config.store.dataPath,
              session.deviceId,
            ),
          },
    );
    this.#session = undefined;
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

  /**
   * Creates a conversation, or hands back the one that already exists.
   *
   * Two things the native binding does on its own have to be done by hand here.
   * There is no index of direct messages, so the existing room is looked for in
   * `m.direct` itself; and nothing writes `m.direct` after a room is created, so
   * a direct message that is not recorded there would come back from sync as an
   * ordinary group with a generated name.
   *
   * The account data write comes after the room exists, and a failure is reported
   * rather than allowed to lose the room: the conversation has been created and
   * the invitation sent, and throwing here would tell the caller nothing had
   * happened. What the user sees instead is a conversation drawn as a group,
   * which the next client to mark it fixes.
   *
   * The parameters that are not the caller's: private, invite-only, encrypted.
   * `TrustedPrivateChat` for a direct message gives both people the same power
   * level, because a conversation between two people has no moderator.
   */
  async createRoom(request: AlloCreateRoomRequest): Promise<string> {
    const client = this.#requireClient('Creating a conversation');
    const invitee = soleDirectInvitee(request);

    if (invitee !== undefined) {
      const existing = this.#existingDirectRoom(client, invitee);
      if (existing !== undefined) {
        return existing;
      }
    }

    const created = await client.createRoom({
      name: request.name,
      visibility: Visibility.Private,
      preset: request.isDirect ? Preset.TrustedPrivateChat : Preset.PrivateChat,
      is_direct: request.isDirect,
      invite: [...request.invite],
      initial_state: [
        {
          type: EventType.RoomEncryption,
          state_key: ENCRYPTION_STATE_KEY,
          content: { algorithm: MEGOLM_ALGORITHM },
        },
      ],
    });

    if (invitee !== undefined) {
      await this.#recordDirectRoom(client, invitee, created.room_id);
    }
    return created.room_id;
  }

  /**
   * The direct message this browser already knows of with one person, if there is
   * one it makes sense to reopen.
   *
   * `m.direct` outlives the rooms it names — leaving a conversation does not
   * remove it — so the membership decides, and a room sync has not delivered is
   * one this client cannot vouch for and does not reuse.
   */
  #existingDirectRoom(client: MatrixClient, userId: string): string | undefined {
    const content = client.getAccountData(EventType.Direct)?.getContent();
    for (const roomId of directRoomsWith(content, userId)) {
      const membership = client.getRoom(roomId)?.getMyMembership();
      if (membership === KnownMembership.Join || membership === KnownMembership.Invite) {
        return roomId;
      }
    }
    return undefined;
  }

  async #recordDirectRoom(client: MatrixClient, userId: string, roomId: string): Promise<void> {
    try {
      const content = client.getAccountData(EventType.Direct)?.getContent();
      await client.setAccountData(EventType.Direct, withDirectRoom(content, userId, roomId));
    } catch (error) {
      logger.error(
        `${LOG_TAG} room ${roomId} was created but could not be marked as a direct ` +
          'message; it will be drawn as a group until some client marks it',
        error,
      );
    }
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

  async recoveryState(): Promise<AlloRecoveryState> {
    const client = this.#requireClient('Reading the recovery state');
    const crypto = this.#requireCrypto('Reading the recovery state');
    return toRecoveryState({
      defaultKeyId: await client.secretStorage.getDefaultKeyId(),
      crossSigningReady: await crypto.isCrossSigningReady(),
      backupActive: (await crypto.getActiveSessionBackupVersion()) !== null,
    });
  }

  /**
   * Creates 4S and the key backup.
   *
   * Note what is *not* passed: neither `setupNewSecretStorage` nor
   * `setupNewCrossSigning`. Both mean "reset even if it already exists", and
   * both are what the spike used because it built a fresh account on every run.
   * In the app they would be the bug this whole path exists to avoid — the
   * caller has already established that there is nothing to reset, and passing
   * them would turn a mistaken state reading into a destroyed store.
   *
   * Nor is `authUploadDeviceSigningKeys`. Uploading cross-signing keys can
   * require interactive auth, and the only interactive auth Allo could satisfy
   * is a Matrix password its users do not have — sessions come from Matrix
   * Authentication Service with Oxy upstream. On a first upload MAS asks for
   * none, which is the case this call is in; if a deployment's homeserver asks
   * anyway, the request fails with the homeserver's own error, which is a better
   * thing to read than a callback that pretends to authenticate and cannot.
   */
  async enableRecovery(passphrase: string): Promise<void> {
    const crypto = this.#requireCrypto('Enabling recovery');

    // Decided before the passphrase is held, so that a refusal leaves nothing
    // behind and nothing has been started.
    const plan = planKeyBackup({
      serverHasBackup: (await crypto.getKeyBackupInfo()) !== null,
      backupActive: (await crypto.getActiveSessionBackupVersion()) !== null,
    });
    if (plan === 'refuse') {
      throw new MatrixBackupExistsOnServerError();
    }

    this.#recoveryPassphrase = passphrase;
    await crypto.bootstrapCrossSigning({});
    await crypto.bootstrapSecretStorage({
      setupNewKeyBackup: plan === 'create',
      createSecretStorageKey: () => crypto.createRecoveryKeyFromPassphrase(passphrase),
    });
    // `bootstrapSecretStorage` creates the backup version on the server, but the
    // local engine only starts using it once it has been checked and trusted.
    // Without this the device has a backup it is not uploading to, and
    // `recoveryState()` — correctly — keeps reporting `incomplete`.
    await crypto.checkKeyBackupAndEnable();
  }

  /**
   * Takes everything this device is missing out of the account's existing 4S.
   *
   * Three calls where the native binding has one, in an order that is not
   * interchangeable — the spike found that skipping the middle one fails with
   * `No decryption key found in crypto store`
   * (`spikes/matrix-web/RESULTS.md`, constraint 2):
   *
   * 1. `bootstrapCrossSigning({})` pulls the cross-signing private keys out of
   *    4S and signs this device with the self-signing key it just got, which is
   *    why recovery leaves the device verified with nobody scanning anything.
   * 2. `loadSessionBackupPrivateKeyFromSecretStorage()` pulls the megolm backup
   *    decryption key out of 4S and into the crypto store.
   * 3. `restoreKeyBackup()` downloads the room keys and imports them, which is
   *    the step that turns unreadable rows into messages.
   */
  async recoverWithPassphrase(passphrase: string): Promise<void> {
    const crypto = this.#requireCrypto('Recovering from the key backup');
    this.#recoveryPassphrase = passphrase;

    await crypto.bootstrapCrossSigning({});
    await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
    await crypto.checkKeyBackupAndEnable();
    const result = await crypto.restoreKeyBackup();
    logger.info(
      `${LOG_TAG} recovered ${result.imported} of ${result.total} room keys from the backup`,
    );
  }

  async openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle> {
    const client = this.#requireSyncing('Opening a timeline');
    const room = this.#requireRoom(roomId, 'Opening a timeline');
    const handle = new WebTimelineHandle(
      client,
      room,
      // The timeline is handed the *authoritative* answer rather than the local
      // one. `roomEncryption` asks the homeserver when sync has not settled the
      // question, and an attachment is exactly the case where the difference
      // matters: see `sendAttachment`.
      () => this.roomEncryption(room.roomId),
      onChange,
      () => {
        this.#timelines.delete(handle);
      },
    );
    this.#timelines.add(handle);
    handle.attach();
    return handle;
  }

  /**
   * Fetches an attachment and answers with an object URL a view can show.
   *
   * The two halves of the trip that the native SDK does inside Rust, done here
   * by hand: download the blob from the media repository, and — when the ref
   * names media from an encrypted room — decrypt it with the key that came
   * inside the event. What the homeserver serves is ciphertext, so a view
   * pointed straight at the mxc URL draws a broken image.
   *
   * The download is authenticated. Since Matrix 1.11 the media endpoints are
   * behind the client's access token, and the unauthenticated ones are being
   * withdrawn; an anonymous fetch works against some homeservers today and
   * against fewer every release.
   */
  async downloadMedia(ref: AlloMediaRef): Promise<AlloMediaFile> {
    const client = this.#requireClient('Downloading an attachment');
    const { source, mimetype } = decodeMediaRef(ref);

    const httpUrl = client.mxcUrlToHttp(
      mxcUriOf(source),
      undefined,
      undefined,
      undefined,
      false,
      true,
      true,
    );
    if (httpUrl === null) {
      throw new MatrixMediaUnreadableError(
        `${mxcUriOf(source)} is not an address on this homeserver's media repository`,
      );
    }

    const response = await fetch(httpUrl, {
      headers: { Authorization: `Bearer ${client.getAccessToken() ?? ''}` },
    });
    if (!response.ok) {
      throw new MatrixMediaUnreadableError(
        `the homeserver refused to serve it (HTTP ${response.status})`,
      );
    }
    const downloaded = new Uint8Array(await response.arrayBuffer());

    const info = encryptionInfoOf(source);
    return toObjectUrl(
      info === undefined ? downloaded : decryptAttachment(downloaded, info),
      mimetype,
    );
  }

  async close(): Promise<void> {
    for (const timeline of [...this.#timelines]) {
      timeline.close();
    }
    for (const roomList of [...this.#roomLists]) {
      roomList.close();
    }
    this.#syncStateListeners.clear();
    this.#sessionListeners.clear();

    const client = this.#client;
    if (client !== undefined && this.#watchingSyncState) {
      client.off(ClientEvent.Sync, this.#onSyncState);
      this.#watchingSyncState = false;
    }
    this.#syncing = false;
    this.#syncState = 'idle';
    this.#recoveryPassphrase = undefined;
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
      // How the crypto stack asks for the key to secret storage. Registered at
      // construction because that is the only place the SDK takes it, and it
      // reads the passphrase through a closure rather than capturing one, so a
      // recovery that happens later still has an answer. See
      // `web/secretStorage.ts`.
      cryptoCallbacks: {
        getSecretStorageKey: createSecretStorageKeyCallback(
          () => this.#recoveryPassphrase,
          deriveRecoveryKeyFromPassphrase,
        ),
      },
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
    // open it at all. The store of a device that is no longer used is deleted by
    // {@link logout}, which builds the same name through the same function.
    //
    // This is also the call the SDK's multi-tab warning is attached to; see the
    // note at the top of this file for what is not being done about it.
    await client.initRustCrypto(
      this.#config.store.kind === 'in-memory'
        ? { useIndexedDB: false }
        : {
            useIndexedDB: true,
            cryptoDatabasePrefix: cryptoDatabasePrefix(
              this.#config.store.dataPath,
              session.deviceId,
            ),
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
   * often.
   *
   * Two things follow, and both matter. {@link session} has to start answering
   * with the new tokens, and whoever is persisting the session has to be told —
   * a copy written at login is correct for minutes and then permanently stale,
   * which is a session that looks persisted and stops restoring. A listener that
   * throws is logged rather than allowed to propagate: this is the SDK's refresh
   * path, and a failed persist must not become a failed refresh.
   */
  #onTokensRefreshed(tokens: AccessTokens): void {
    const session = this.#session;
    if (session === undefined) {
      return;
    }
    const refreshed: AlloSession = {
      ...session,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
    this.#session = refreshed;
    // Never the tokens themselves: they are credentials.
    logger.info(`${LOG_TAG} the session's tokens were refreshed`);

    for (const listener of this.#sessionListeners) {
      try {
        listener(refreshed);
      } catch (error) {
        logger.error(`${LOG_TAG} a refreshed session could not be handled`, error);
      }
    }
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

  #requireCrypto(operation: string): WebCryptoApi {
    const crypto = this.#requireClient(operation).getCrypto();
    if (crypto === undefined) {
      throw new MatrixCryptoUnavailableError(operation);
    }
    return crypto;
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
    const viewerUserId = this.#client.getSafeUserId();
    const entries: RoomListEntry[] = [];

    // `getVisibleRooms` and not `getRooms`: it drops the old versions of rooms
    // that have been upgraded, which are rooms the user has already been moved
    // out of.
    for (const room of this.#client.getVisibleRooms()) {
      const timeline = room.getLiveTimeline();
      const summary = toRoomSummary(
        room,
        timeline.getState(EventTimeline.FORWARDS),
        direct.has(room.roomId),
        // The live timeline and not `getLastLiveEvent()`: the row previews the
        // room's last *message*, and the last event of all is as likely to be
        // somebody joining. See `selectRoomPreview`.
        selectRoomPreview(timeline.getEvents(), viewerUserId),
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
  readonly #roomEncryption: () => Promise<AlloEncryptionState>;
  readonly #onChange: (items: readonly AlloTimelineItem[]) => void;
  readonly #onClose: () => void;
  readonly #coalescer: Coalescer;
  readonly #typingListeners = new Set<(userIds: readonly string[]) => void>();

  #items: readonly AlloTimelineItem[] = [];
  #typing: readonly string[] = [];
  #closed = false;

  constructor(
    client: MatrixClient,
    room: Room,
    roomEncryption: () => Promise<AlloEncryptionState>,
    onChange: (items: readonly AlloTimelineItem[]) => void,
    onClose: () => void,
  ) {
    this.#client = client;
    this.#room = room;
    this.#roomEncryption = roomEncryption;
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
    // Somebody read something. Nothing else reports it: a receipt is not a
    // timeline event, and it is what moves a row's read mark.
    this.#client.on(RoomEvent.Receipt, this.#onRoomChanged);
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

  /**
   * Uploads an attachment and sends the event that points at it.
   *
   * **This is the one place in Allo where a photograph could leave a device
   * unencrypted, and the shape of it is what stops that.** `matrix-js-sdk` has
   * no equivalent of the native SDK's `sendImage`: `uploadContent` uploads
   * whatever it is given to a public URL, and `sendMessage` will put an
   * `m.image` with a plaintext `url` into an encrypted room without a word.
   * Every byte that goes up therefore passes through
   * {@link resolveAttachmentSource}, which reads the room's encryption state
   * and refuses to guess — see `web/attachments.ts`.
   *
   * The state is asked for **once** and used for both the attachment and its
   * thumbnail. Asking twice would let a room that finished syncing in between
   * produce an event with an encrypted picture and a thumbnail of it in the
   * clear, which leaks the picture almost as well as the picture would.
   */
  async sendAttachment(attachment: AlloOutgoingAttachment): Promise<void> {
    const encryption = await this.#roomEncryption();
    const deps = { upload: this.#upload, encrypt: encryptAttachment };

    const bytes = await readAttachmentBytes(attachment.uri);
    const source = await resolveAttachmentSource(
      { bytes, mimetype: attachment.mimetype, filename: attachment.filename },
      encryption,
      this.#room.roomId,
      deps,
    );

    let thumbnail: OutgoingThumbnailSource | undefined;
    if (attachment.thumbnail !== undefined) {
      const small = attachment.thumbnail;
      const thumbnailSource = await resolveAttachmentSource(
        {
          bytes: await readAttachmentBytes(small.uri),
          mimetype: small.mimetype,
          filename: `thumb-${attachment.filename}`,
        },
        encryption,
        this.#room.roomId,
        deps,
      );
      thumbnail = {
        source: thumbnailSource,
        mimetype: small.mimetype,
        width: small.width,
        height: small.height,
      };
    }

    const content = toAttachmentContent(attachment, source, thumbnail, bytes.byteLength);
    const roomId = this.#room.roomId;

    // The `msgtype` is added here and not in `attachments.ts` because it is the
    // SDK's own enum, and that module must not import a value from the SDK —
    // its tests would drag the whole thing in. A switch and not a lookup table
    // because `sendMessage` takes a union of four content shapes, one per
    // msgtype, and only a narrowed literal picks an arm of it.
    switch (attachment.kind) {
      case 'image':
        await this.#client.sendMessage(roomId, { ...content, msgtype: MsgType.Image });
        return;
      case 'video':
        await this.#client.sendMessage(roomId, { ...content, msgtype: MsgType.Video });
        return;
      case 'audio':
      case 'voice':
        await this.#client.sendMessage(roomId, { ...content, msgtype: MsgType.Audio });
        return;
      case 'file':
        await this.#client.sendMessage(roomId, { ...content, msgtype: MsgType.File });
        return;
    }
  }

  /**
   * Hands bytes to the media repository.
   *
   * `includeFilename: false` for every upload, encrypted or not. The filename
   * travels inside the event — which in an encrypted room is encrypted — and
   * repeating it on the unauthenticated upload endpoint would put
   * `passport-scan.jpg` in the homeserver's access log beside a blob that was
   * encrypted precisely so it would not say what it is.
   */
  readonly #upload = async (payload: {
    readonly bytes: Uint8Array;
    readonly mimetype: string;
  }): Promise<string> => {
    const { content_uri: contentUri } = await this.#client.uploadContent(
      new Blob([payload.bytes.slice().buffer], { type: payload.mimetype }),
      { type: payload.mimetype, includeFilename: false },
    );
    return contentUri;
  };

  /**
   * Adds the viewer's annotation, or redacts the one they already sent.
   *
   * The SDK has no toggle, so the decision is made here, and it is made from the
   * aggregated relations rather than from anything this handle remembers: a
   * reaction sent from the user's phone a second ago is in there and is not in
   * any local state.
   */
  async toggleReaction(eventId: string, key: string): Promise<void> {
    const existing = this.#viewerReaction(eventId, key);
    if (existing !== undefined) {
      await this.#client.redactEvent(this.#room.roomId, existing);
      return;
    }
    await this.#client.sendEvent(this.#room.roomId, EventType.Reaction, {
      'm.relates_to': { rel_type: RelationType.Annotation, event_id: eventId, key },
    });
  }

  async edit(eventId: string, body: string): Promise<void> {
    await this.#client.sendMessage(this.#room.roomId, {
      msgtype: MsgType.Text,
      body: `${EDIT_FALLBACK_PREFIX}${body}`,
      'm.new_content': { msgtype: MsgType.Text, body },
      'm.relates_to': { rel_type: RelationType.Replace, event_id: eventId },
    });
  }

  async redact(eventId: string, reason: string | undefined): Promise<void> {
    await this.#client.redactEvent(this.#room.roomId, eventId, undefined, { reason });
  }

  /**
   * Sends a public read receipt for one event.
   *
   * An event id the room does not hold is reported and dropped rather than
   * thrown: the caller is a reader scrolling, the id came from a timeline that
   * may since have been reset by a gappy sync, and there is no version of "your
   * read receipt did not go out" worth interrupting them with.
   */
  async sendReadReceipt(eventId: string): Promise<void> {
    const event = this.#room.findEventById(eventId);
    if (event === undefined) {
      logger.warn(
        `${LOG_TAG} no read receipt was sent for ${eventId}: it is not in ` +
          `${this.#room.roomId}`,
      );
      return;
    }
    // `Read` and not `ReadPrivate`: a mark nobody else can see is one the
    // sender's own bubble could never draw, and drawing it is the point.
    await this.#client.sendReadReceipt(event, ReceiptType.Read);
  }

  async sendTypingNotice(isTyping: boolean): Promise<void> {
    await this.#client.sendTyping(this.#room.roomId, isTyping, TYPING_NOTICE_TIMEOUT_MS);
  }

  observeTyping(onChange: (userIds: readonly string[]) => void): AlloUnsubscribe {
    this.#typingListeners.add(onChange);
    if (this.#typingListeners.size === 1) {
      this.#client.on(RoomMemberEvent.Typing, this.#onTyping);
    }
    return () => {
      this.#typingListeners.delete(onChange);
      if (this.#typingListeners.size === 0) {
        this.#client.off(RoomMemberEvent.Typing, this.#onTyping);
      }
    };
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
    this.#client.off(RoomEvent.Receipt, this.#onRoomChanged);
    this.#client.off(MatrixEventEvent.Decrypted, this.#onEventChanged);
    this.#client.off(MatrixEventEvent.Replaced, this.#onEventChanged);
    if (this.#typingListeners.size > 0) {
      this.#client.off(RoomMemberEvent.Typing, this.#onTyping);
    }
    this.#typingListeners.clear();

    this.#onClose();
  }

  /**
   * The id of the viewer's own annotation with this key, if they sent one.
   *
   * Redacted annotations are skipped: the relation container usually drops them
   * on redaction, and redacting one twice would be a request the homeserver
   * refuses rather than a reaction the user gets back.
   */
  #viewerReaction(eventId: string, key: string): string | undefined {
    const viewerUserId = this.#client.getSafeUserId();
    const annotations = this.#room.relations.getChildEventsForEvent(
      eventId,
      RelationType.Annotation,
      EventType.Reaction,
    );
    for (const annotation of annotations?.getRelations() ?? []) {
      if (
        annotation.getSender() === viewerUserId &&
        annotation.getRelation()?.key === key &&
        !annotation.isRedacted()
      ) {
        return annotation.getId();
      }
    }
    return undefined;
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

  /**
   * Not coalesced with the timeline.
   *
   * The two travel at different speeds and mean different things: a typing notice
   * is only useful while it is true, and putting it behind the same frame of
   * delay as a batch of decrypted messages is how "is typing" arrives after the
   * message it was announcing.
   */
  readonly #onTyping = (_event: MatrixEvent, member: { roomId: string }): void => {
    if (member.roomId === this.#room.roomId) {
      this.#publishTyping();
    }
  };

  #publishTyping(): void {
    if (this.#closed) {
      return;
    }
    const viewerUserId = this.#client.getSafeUserId();
    // Asked of the room rather than accumulated from the events, because the
    // SDK's members are the state the events have already been applied to — and
    // one member stopping does not tell us about the others.
    const typing = this.#room
      .getMembers()
      .filter((member) => member.typing && member.userId !== viewerUserId)
      .map((member) => member.userId);

    if (
      typing.length === this.#typing.length &&
      typing.every((userId, index) => userId === this.#typing[index])
    ) {
      // `RoomMember.typing` is republished on every sync that carries an
      // `m.typing`, which for one person typing steadily is several a second.
      return;
    }
    this.#typing = typing;
    for (const listener of this.#typingListeners) {
      listener(typing);
    }
  }

  #publish(): void {
    if (this.#closed) {
      return;
    }

    const viewerUserId = this.#client.getSafeUserId();
    const items: AlloTimelineItem[] = [];
    const readers: (readonly string[])[] = [];
    // Local echoes are in here too: the client is started with the SDK's default
    // chronological ordering, which puts a message in the timeline the moment it
    // is sent rather than in a list of its own.
    for (const event of this.#room.getLiveTimeline().getEvents()) {
      // Reactions, redactions and edits are in the timeline and are not rows of
      // it; each one changes a row that is already there. See `isTimelineRow`.
      if (!isTimelineRow(event)) {
        continue;
      }
      const item = toTimelineItem(event, viewerUserId, this.#reactionsFor(event));
      if (item === undefined) {
        logger.warn(
          `${LOG_TAG} an event in ${this.#room.roomId} has neither an event id nor a ` +
            'transaction id and cannot be drawn',
        );
        continue;
      }
      items.push(item);
      readers.push(toReaders(this.#room.getReceiptsForEvent(event)));
    }

    // A receipt names one event and covers every earlier one, so the read mark of
    // a row comes from what is *after* it. See `lib/matrix/readReceipts.ts`.
    const readByOthers = markReadByOthers(
      items.map((item, index) => ({ sender: item.sender, readers: readers[index] })),
    );

    this.#items = items.map((item, index) =>
      readByOthers[index] ? { ...item, isReadByOthers: true } : item,
    );
    this.#onChange(this.#items);
  }

  /**
   * The reactions the SDK has aggregated onto one event.
   *
   * A local echo has no event id the homeserver knows, so nothing can have
   * annotated it yet and there is nothing to look up.
   */
  #reactionsFor(event: MatrixEvent): readonly AlloReaction[] {
    const eventId = event.getId();
    if (eventId === undefined) {
      return NO_REACTIONS;
    }
    return toReactions(
      this.#room.relations
        .getChildEventsForEvent(eventId, RelationType.Annotation, EventType.Reaction)
        ?.getSortedAnnotationsByKey() ?? null,
    );
  }
}
