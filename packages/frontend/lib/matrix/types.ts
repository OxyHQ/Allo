/**
 * The Allo chat port.
 *
 * This is not a layer that abstracts Matrix. It is a narrow port shaped by what
 * Allo's UI draws, with one implementation per platform resolved by file
 * extension (`client.native.ts` on iOS/Android, `client.ts` on web). See
 * `docs/matrix/client-strategy.md` §2.3.
 *
 * The rule that keeps it narrow: if this file grows a member that only one of
 * the two SDKs can answer, the abstraction is breaking and the answer belongs in
 * the UI, not in a new method here.
 *
 * Nothing in this file may import a Matrix SDK. Every type below is an Allo view
 * model; each implementation translates towards it.
 */

/**
 * Whether a room is encrypted.
 *
 * Three values, not a boolean. The third one is not a technicality: right after
 * a room is created the `m.room.encryption` state event has not arrived through
 * sync yet, so the honest answer is "not known yet". Collapsing it into `false`
 * — which is what the SDK's own `isEncrypted()` does — reports an encrypted room
 * as unencrypted, and the UI hangs a padlock off that answer. See
 * `docs/matrix/data-model.md` §5.1 and §5.3.
 */
export type AlloEncryptionState = 'encrypted' | 'unencrypted' | 'unknown';

/** The viewer's own membership in a room. */
export type AlloRoomMembership = 'joined' | 'invited' | 'left' | 'knocked' | 'banned';

/** State of the background sync loop that feeds every observer in this port. */
export type AlloSyncState = 'idle' | 'running' | 'offline' | 'terminated' | 'error';

/** Where an outgoing event is in its journey to the homeserver. */
export type AlloSendState = 'pending' | 'sent' | 'failed';

/** Outcome of asking for older events. */
export type AlloPaginationOutcome = 'reached-start' | 'more-available';

/** Releases a subscription. Calling it more than once is safe. */
export type AlloUnsubscribe = () => void;

/**
 * A room as the conversation list draws it.
 *
 * `encryption` here is whatever sync has told us so far and may well be
 * `'unknown'`; {@link AlloChatClient.roomEncryption} is the call that resolves
 * that against the server.
 */
export interface AlloRoomSummary {
  readonly roomId: string;
  /** The name from room state, or one computed from the members. */
  readonly displayName: string | undefined;
  readonly avatarUrl: string | undefined;
  readonly isDirect: boolean;
  readonly membership: AlloRoomMembership;
  readonly encryption: AlloEncryptionState;
  /** Messages the viewer has not read, independent of notification settings. */
  readonly unreadCount: number;
}

/**
 * How an event addresses itself.
 *
 * A message the viewer just sent exists in the timeline before the homeserver
 * has given it an event id, and until then it is only addressable by the
 * transaction id the SDK minted for it.
 */
export type AlloEventKey =
  | { readonly kind: 'remote'; readonly eventId: string }
  | { readonly kind: 'local'; readonly transactionId: string };

/**
 * What a timeline row says.
 *
 * `undecryptable` is a state of its own, not the absence of text. An event whose
 * content is `UnableToDecrypt` carries no `body` at all, so "arrived but cannot
 * be read" and "did not arrive" are different facts and the UI has to be able to
 * tell them apart — a device that has just been set up sees the first one for
 * every message sent before it existed.
 *
 * Why the *reason* for the failure is not here: the Rust SDK classifies it into
 * nine `UtdCause` values that `matrix-js-sdk` does not share. Exposing them would
 * tie this view model to one of the two implementations.
 */
export type AlloEventContent =
  | { readonly kind: 'text'; readonly body: string; readonly isEdited: boolean }
  | { readonly kind: 'undecryptable' }
  | { readonly kind: 'redacted' }
  /** An event Allo does not draw yet. `description` names the kind, for logs. */
  | { readonly kind: 'unsupported'; readonly description: string };

/** A row of a conversation. */
export interface AlloTimelineItem {
  /**
   * Identity of the row within its timeline, stable across the moment a local
   * echo becomes a remote event. This is the list key, not the event id.
   */
  readonly key: string;
  readonly id: AlloEventKey;
  /** Matrix user id of the sender. */
  readonly sender: string;
  /** Undefined while the sender's profile has not been resolved. */
  readonly senderDisplayName: string | undefined;
  /** Milliseconds since the Unix epoch. */
  readonly sentAt: number;
  readonly isOwn: boolean;
  readonly sendState: AlloSendState;
  readonly content: AlloEventContent;
}

/**
 * Who Allo says it is to the authorization server.
 *
 * This is a property of the app, not of a login attempt, so it is given once when
 * the client is built.
 */
export interface AlloOidcClientMetadata {
  /** Shown to the user on the authorization server's consent screen. */
  readonly clientName: string;
  /** Where the authorization server sends the user back. Allo's deep link. */
  readonly redirectUri: string;
  /** A page describing the app, shown alongside its name. */
  readonly clientUri: string;
  readonly logoUri?: string;
  readonly tosUri?: string;
  readonly policyUri?: string;
  /**
   * Client ids agreed in advance, keyed by homeserver or issuer URL, for servers
   * that do not register clients dynamically.
   */
  readonly staticRegistrations?: ReadonlyMap<string, string>;
}

/** What the authorization server is asked to show the user. */
export type AlloOidcPrompt = 'create' | 'login' | 'consent';

export interface AlloOidcLoginOptions {
  readonly prompt?: AlloOidcPrompt;
  /**
   * An identifier to pre-fill. Its format is the upstream provider's, not
   * Matrix's — for MAS with no upstream provider it is the one MSC4198 defines.
   */
  readonly loginHint?: string;
  /**
   * Reuse a device id from an earlier session. Only correct if this device still
   * holds that session's encryption keys; otherwise it takes over the identity of
   * a device whose keys are gone and the history it could read goes with them.
   */
  readonly deviceId?: string;
}

/**
 * An authorization in flight.
 *
 * Login is three steps and this type refuses to pretend otherwise: the app asks
 * for a URL, hands it to a browser it does not control, and comes back with
 * whatever the browser was redirected to. The middle step is not the port's, and
 * hiding all three behind one call that looked synchronous would be a lie about
 * where the app has to hand over control.
 *
 * Exactly one of {@link complete} and {@link abort} settles it; calling either
 * afterwards throws.
 */
export interface AlloOidcLoginRequest {
  /** The URL to open in the browser. */
  readonly authorizationUrl: string;
  /** Finishes the login with the URL the browser was redirected back to. */
  complete(callbackUrl: string): Promise<AlloSession>;
  /** Abandons the attempt and releases what the server is holding for it. */
  abort(): Promise<void>;
}

/**
 * A logged-in session, in the form it has to be persisted to be restored later.
 *
 * `accessToken`, `refreshToken` and `authData` are credentials: they must never
 * be logged, never sent to Allo's backend, and never written anywhere but the
 * device keychain.
 *
 * A warning that matters more under OIDC than it did under a password: **these
 * tokens rotate**. The SDK refreshes them on its own, and this port does not yet
 * report when it does, so a session stored once and never refreshed goes stale
 * and stops restoring. Persisting sessions needs that gap closed first.
 */
export interface AlloSession {
  readonly userId: string;
  readonly deviceId: string;
  readonly homeserverUrl: string;
  readonly accessToken: string;
  readonly refreshToken: string | undefined;
  /**
   * State the implementation cannot restore a session without, and that only it
   * can read. Store it and hand it back unchanged; never parse it, and never move
   * it between platforms — what the native client writes here means nothing to
   * the web one.
   */
  readonly authData: string | undefined;
}

/**
 * Where the client keeps its state and its crypto store.
 *
 * `in-memory` throws away the device identity when the process dies, which makes
 * it right for tests and wrong for the app.
 */
export type AlloClientStore =
  | { readonly kind: 'in-memory' }
  | { readonly kind: 'filesystem'; readonly dataPath: string; readonly cachePath: string };

export interface AlloChatClientConfig {
  readonly homeserverUrl: string;
  readonly store: AlloClientStore;
  readonly oidc: AlloOidcClientMetadata;
}

/**
 * A live, ordered view of the room list.
 *
 * `rooms()` plus `subscribe`-shaped `onChange` is deliberate: it is what
 * `useSyncExternalStore` wants, so binding this to React needs no Effect to
 * mirror it into component state.
 */
export interface AlloRoomListHandle {
  /** The current list. The array is replaced, never mutated. */
  rooms(): readonly AlloRoomSummary[];
  /** Stops the subscription. The list stops updating. */
  close(): void;
}

/**
 * A live view of one conversation, plus the two operations that only make sense
 * with it open.
 *
 * Sending lives here and not on the client because in the Rust binding sending
 * *is* a timeline operation — `Room` has no send method — and a message's local
 * echo belongs to the timeline that produced it.
 */
export interface AlloTimelineHandle {
  /** The current items, oldest first. The array is replaced, never mutated. */
  items(): readonly AlloTimelineItem[];
  /** Asks for up to `count` older events. */
  paginateBackwards(count: number): Promise<AlloPaginationOutcome>;
  /** Sends plain text. The body is sent verbatim; it is not parsed as markdown. */
  sendText(body: string): Promise<void>;
  close(): void;
}

/**
 * Everything Allo asks of a Matrix homeserver.
 *
 * Ordering rules that the implementations share, because they come from the
 * protocol and not from either SDK:
 *
 * - a login must finish, or a session be restored, before {@link startSync}.
 * - {@link startSync} must happen before {@link observeRooms} or
 *   {@link openTimeline}: both are views over the sync loop's state, and there is
 *   nothing to view before it runs.
 *
 * There is no password login and there will not be one. Allo's homeserver issues
 * sessions through Matrix Authentication Service with Oxy upstream, so the user
 * never has a Matrix password to give.
 */
export interface AlloChatClient {
  /**
   * Starts an authorization. See {@link AlloOidcLoginRequest} for the two steps
   * that follow.
   */
  beginOidcLogin(options?: AlloOidcLoginOptions): Promise<AlloOidcLoginRequest>;
  /** Reinstates a session persisted from a previous run. */
  restoreSession(session: AlloSession): Promise<void>;
  /** The current session. Throws if nobody has logged in. */
  session(): AlloSession;

  /** Starts, or restarts after {@link stopSync}, the background sync loop. */
  startSync(): Promise<void>;
  stopSync(): Promise<void>;
  /**
   * Reports the sync state, starting with the current one, right away and
   * synchronously. Subscribing before {@link startSync} is allowed and is the
   * expected order.
   */
  observeSyncState(onChange: (state: AlloSyncState) => void): AlloUnsubscribe;

  observeRooms(
    onChange: (rooms: readonly AlloRoomSummary[]) => void,
  ): Promise<AlloRoomListHandle>;

  /**
   * The authoritative encryption state of a room, asking the server when sync
   * has not settled it locally.
   */
  roomEncryption(roomId: string): Promise<AlloEncryptionState>;

  openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle>;

  /** Stops sync and releases every handle this client handed out. */
  close(): Promise<void>;
}

/** Builds a client. Resolved per platform; see the note at the top of this file. */
export type AlloChatClientFactory = (
  config: AlloChatClientConfig,
) => Promise<AlloChatClient>;
