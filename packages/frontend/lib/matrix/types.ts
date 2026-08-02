/**
 * The Allo chat port.
 *
 * This is not a layer that abstracts Matrix. It is a narrow port shaped by what
 * Allo's UI draws, with one implementation per platform resolved by file
 * extension (`client.native.ts` on iOS/Android, `client.web.ts` on web). See
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
 *
 * `membership` is also what tells an **invitation** apart from a conversation.
 * The list holds everything the viewer has not left, invitations included, and
 * an invited room is not a conversation yet: it has no readable timeline, so its
 * {@link latestMessage} is absent, and opening it yields nothing to draw. What
 * the port owes the UI is the fact; what to do with it is the UI's.
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
  /**
   * The room's most recent message, or `undefined` when this device knows of
   * none.
   *
   * `undefined` is a real answer and not a placeholder: an invitation, a room
   * created a second ago, and a room whose messages have not reached this device
   * all have no latest message, and the row for one has no preview and no time.
   * Substituting the current time is the mistake this shape exists to prevent —
   * it puts "now" beside every conversation in the app, including one nobody has
   * touched in a year.
   */
  readonly latestMessage: AlloRoomPreview | undefined;
}

/**
 * The one message a conversation row previews.
 *
 * It carries {@link AlloEventContent} rather than a string because a preview is
 * subject to every state a timeline row is: the latest message of an encrypted
 * room may not be decryptable on this device yet, which is a state of its own and
 * not an empty preview, and it stops being true the moment the room key arrives.
 *
 * `sentAt` is the row's activity time, and there is deliberately no separate
 * field for it. A time and a preview are the same fact seen twice — a row cannot
 * honestly show one without the other — and one field cannot go stale against
 * the other.
 *
 * The sender travels with it because a group conversation's row says who spoke,
 * and both SDKs hand the sender over inside the very object this is read from.
 * Asking for it later would mean a timeline open per room in the list.
 *
 * **What counts as "the latest message".** Message-like events only: text,
 * stickers, polls, media, an event that failed to decrypt, and a message that has
 * been redacted. Someone joining a room is not the room's latest message, and a
 * list that said so would replace every preview with a membership change every
 * time anyone came or went.
 */
export interface AlloRoomPreview {
  /** Milliseconds since the Unix epoch. */
  readonly sentAt: number;
  /** Matrix user id of the sender. */
  readonly sender: string;
  /** Undefined while the sender's profile has not been resolved. */
  readonly senderDisplayName: string | undefined;
  readonly isOwn: boolean;
  readonly content: AlloEventContent;
}

/**
 * Somebody a room holds.
 *
 * **No avatar**, and that is a decision rather than an omission. What both SDKs
 * have for a member is an `mxc://` URI, which is not something a view can
 * fetch — the same problem {@link AlloMediaRef} exists for — so a field here
 * would be a URL that draws a broken image in every member row. Until member
 * avatars go through {@link AlloChatClient.downloadMedia} the honest list is
 * names, and a name is what a row needs to be readable anyway.
 */
export interface AlloRoomMember {
  readonly userId: string;
  /** The name the room knows them by. Absent when they have set none. */
  readonly displayName: string | undefined;
  /**
   * Whether they are in the room or have only been asked.
   *
   * Two values and not the five of {@link AlloRoomMembership}: this list is who
   * is in the room, so somebody who left, was removed or was banned is not in
   * it. Reporting them would make "who is in this conversation" a list that
   * includes people who are not.
   */
  readonly membership: 'joined' | 'invited';
}

/**
 * What the viewer may do in a room.
 *
 * Read from the room's power levels, which is the only authority for it: a
 * client that decides on its own is a client that draws a button the homeserver
 * then refuses. Both fields answer for *this* viewer in *this* room and nobody
 * else.
 *
 * They are two booleans and not one `isAdmin`, because Matrix does not have
 * administrators — it has a power level per action, and a room can perfectly
 * well let somebody invite people and not rename it.
 */
export interface AlloRoomRights {
  readonly canInvite: boolean;
  readonly canRename: boolean;
}

/**
 * A room, as the screen that administers it draws it.
 *
 * Separate from {@link AlloRoomSummary} — which is a *row* in a list and is kept
 * deliberately cheap — because everything here costs a read of the room's whole
 * member list and its power levels, and the conversation list would pay it once
 * per room.
 */
export interface AlloRoomDetails {
  readonly roomId: string;
  /** The name from room state, or one computed from the members. */
  readonly name: string | undefined;
  readonly isDirect: boolean;
  /**
   * Everybody in the room, the viewer included, ordered by the name they are
   * drawn with.
   *
   * The viewer is in it because they are in the room, and a list of "everybody
   * else" is a different question the screen can ask by knowing who it is. The
   * order is the port's because neither SDK has one: an unordered list would
   * reshuffle itself between two reads of the same unchanged room.
   */
  readonly members: readonly AlloRoomMember[];
  readonly rights: AlloRoomRights;
}

/**
 * A conversation to be created.
 *
 * There is no "encrypted" option, and that is a decision rather than an omission:
 * Allo is an encrypted messenger, and encryption in Matrix is one-way — a room
 * created without it can never be given it. An option here would let a mistake
 * become a conversation that is permanently in the clear.
 */
export interface AlloCreateRoomRequest {
  /** Matrix user ids to invite. A conversation with nobody in it is allowed. */
  readonly invite: readonly string[];
  /** Absent for a direct message, whose name is computed from its members. */
  readonly name: string | undefined;
  /**
   * Whether this is a one-to-one conversation, which is a claim about the room
   * and not a count of its invitees: it decides `m.direct`, and through it the
   * name and avatar the room is drawn with.
   */
  readonly isDirect: boolean;
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
  | { readonly kind: 'media'; readonly media: AlloMediaContent }
  | { readonly kind: 'undecryptable' }
  | { readonly kind: 'redacted' }
  /**
   * Past the lifetime an ephemeral conversation gives its messages, and not
   * redacted yet.
   *
   * Distinct from `redacted`, which is a fact about the homeserver: this one is
   * a fact about this device's clock, and it is the *weaker* of the two. It
   * means "this device will not draw this any more"; the event's content is
   * still on the homeserver until whoever sent it redacts it, and their client
   * only does that while it is running. See `docs/matrix/ephemeral.md`.
   *
   * Neither implementation of this port ever produces it. It is put on a row by
   * `lib/matrix/ephemeral/expiry.ts`, from the row's own timestamp and the
   * conversation's policy, which is why it is here rather than in a view model:
   * whatever draws a timeline has to know it may see it.
   */
  | { readonly kind: 'expired' }
  /** An event Allo does not draw yet. `description` names the kind, for logs. */
  | { readonly kind: 'unsupported'; readonly description: string };

/* ---------------------------------------------------------------------------
 * Attachments
 *
 * Media in Matrix is two things that arrive separately: an event in the room,
 * which is what the timeline carries, and bytes in the homeserver's media
 * repository, which are fetched on demand. **In an encrypted room the bytes are
 * encrypted by the sending client before they are uploaded**, so the homeserver
 * stores an opaque blob and the key travels inside the encrypted event — the
 * same protection the message body already has, and the reason Allo does not
 * need an upload endpoint of its own. See `docs/matrix/ui-wiring.md` §7.
 * ------------------------------------------------------------------------- */

/**
 * What an attachment is, in the vocabulary the protocol has for it.
 *
 * `voice` is not a sixth msgtype — it is an `m.audio` a client marked as a voice
 * note — but it is a separate kind here because the two are drawn differently
 * and the distinction is lost the moment it is collapsed.
 */
export type AlloMediaKind = 'image' | 'video' | 'audio' | 'voice' | 'file';

/**
 * Where bytes live, in a form only the implementation that produced it can read.
 *
 * **Opaque.** It is a string so it can be a React key and travel through view
 * models that know nothing about Matrix, and that is the only thing anything
 * outside `lib/matrix/` may do with it: never parse it, never build one by hand,
 * never move one between platforms. What the native half writes into it — a
 * serialized `MediaSource` — means nothing to the web half, which writes an mxc
 * URI or a whole encrypted-file descriptor.
 *
 * It is deliberately *not* a URL. A URL implies something a view can fetch, and
 * media in an encrypted room is exactly the case where that is false: what the
 * homeserver serves at the underlying address is ciphertext. {@link
 * AlloChatClient.downloadMedia} is the only way to turn one of these into
 * something that can be displayed.
 */
export type AlloMediaRef = string;

/** An attachment, as a timeline row carries it. */
export interface AlloMediaContent {
  readonly kind: AlloMediaKind;
  /** The filename the sender's client computed. Never empty. */
  readonly filename: string;
  /**
   * What the sender wrote alongside the attachment, if anything.
   *
   * Distinct from {@link filename}: a caption is prose the sender chose, and a
   * filename is `IMG_4032.HEIC`. Drawing the second one as the first is the
   * mistake this separation exists to prevent.
   */
  readonly caption: string | undefined;
  readonly source: AlloMediaRef;
  /**
   * A smaller copy of the same picture, uploaded by the sender beside it.
   *
   * Absent whenever the sender's client made none, which is common. It is the
   * sender's and not the server's on purpose: a homeserver can only thumbnail
   * what it can read, so in an encrypted room the *only* thumbnail that exists
   * is one the sending client encrypted and uploaded itself. Asking the server
   * to thumbnail an encrypted upload yields a picture of ciphertext.
   */
  readonly thumbnail: AlloMediaRef | undefined;
  /** Pixels. Absent when the sender's client did not say. */
  readonly width: number | undefined;
  readonly height: number | undefined;
  /** Milliseconds, for audio and video. Absent for everything else. */
  readonly durationMs: number | undefined;
  /** Bytes, as the sender's client reported them. Not verified here. */
  readonly size: number | undefined;
}

/** Bytes ready to be displayed, and the means to let go of them. */
export interface AlloMediaFile {
  /**
   * A URI this app can hand to an image or a video view: a `file://` path on
   * iOS and Android, a `blob:` URL on web.
   */
  readonly uri: string;
  /**
   * Releases what backs {@link uri}, after which it no longer resolves.
   *
   * Not optional housekeeping on either platform: a `blob:` URL pins its bytes
   * in the tab's memory until it is revoked, and a decrypted file on a phone is
   * plaintext sitting in the cache directory. Calling it more than once is safe.
   */
  release(): void;
}

/**
 * A picture or a small copy of one, on its way out.
 *
 * `uri` is whatever the platform's picker handed over — a `file://` path on a
 * phone, a `blob:` or `data:` URL in a browser — and each implementation reads
 * it the way its own SDK wants. The UI does not have to know which.
 */
export interface AlloOutgoingThumbnail {
  readonly uri: string;
  readonly mimetype: string;
  readonly width: number;
  readonly height: number;
}

/**
 * An attachment on its way out.
 *
 * **There is no "encrypt this" option, and there must never be one.** Whether an
 * attachment is encrypted is decided by the room it is being sent to, inside the
 * implementation, from the room's own encryption state — never by a caller. A
 * boolean here would be a way for one screen, one refactor or one default
 * argument to put a photograph on a homeserver in the clear while every message
 * around it stays encrypted, and nothing in the UI would look any different.
 * See `AlloTimelineHandle.sendAttachment`.
 */
export interface AlloOutgoingAttachment {
  readonly kind: AlloMediaKind;
  /** Shown by clients that list attachments, and used to pick an extension. */
  readonly filename: string;
  readonly mimetype: string;
  /** Where the bytes are now. See {@link AlloOutgoingThumbnail.uri}. */
  readonly uri: string;
  /** Prose to send with it. */
  readonly caption?: string;
  readonly width?: number;
  readonly height?: number;
  /** Bytes. Sent so receivers can decide before downloading. */
  readonly size?: number;
  /** Milliseconds. For audio and video. */
  readonly durationMs?: number;
  /**
   * A small copy to send alongside, so receivers can draw the row without
   * downloading the whole thing. See {@link AlloMediaContent.thumbnail} for why
   * the sender is the only one who can make it.
   */
  readonly thumbnail?: AlloOutgoingThumbnail;
}

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
  /** Empty when nobody has reacted. Never `undefined`. */
  readonly reactions: readonly AlloReaction[];
  /**
   * Somebody other than the sender has read this row.
   *
   * A boolean and not a list of readers, because that is the question the bubble
   * asks and because the honest list is not available: a Matrix receipt is a
   * high-water mark, so the only thing known about a reader who has moved on is
   * that they read *at least* this far. Reporting a list would invite a group
   * conversation to draw "read by 2 of 5" out of numbers that do not mean that.
   *
   * The sender is excluded from their own count. Clients send a receipt for the
   * message they have just sent, and letting that count would put the read mark
   * on every outgoing message the instant it left.
   */
  readonly isReadByOthers: boolean;
}

/* ---------------------------------------------------------------------------
 * Message operations
 *
 * Everything below to the end of this comment block is about acting on a message
 * that already exists — reacting to it, editing it, removing it — and about the
 * two signals that travel alongside a conversation rather than inside it: read
 * receipts and typing notices. The calls themselves live on
 * {@link AlloTimelineHandle}, for the same reason `sendText` does: they are
 * operations on an open conversation, and in the Rust binding most of them are
 * literally timeline methods.
 * ------------------------------------------------------------------------- */

/**
 * One emoji, and everybody who sent it.
 *
 * Senders and not a count, because the only two questions the UI asks are how
 * many there are and whether the viewer is among them, and a count answers only
 * the first. Matrix identifies a reaction by an arbitrary string — `key` in the
 * spec — which is an emoji by convention and not by rule; it is passed through
 * unchanged rather than validated, because a homeserver will happily carry one
 * Allo cannot draw and dropping it would understate the count.
 */
export interface AlloReaction {
  /** The reaction itself, usually a single emoji. */
  readonly key: string;
  /** Matrix user ids, without duplicates. */
  readonly senders: readonly string[];
}

/* ------------------------------------------------------------------------- */

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
   *
   * Under OIDC the device id belongs to the client, not the server — it is
   * carried in the requested scope — and it is what an installation's identity
   * and its encryption keys hang off. Left unset, a new one is minted, which
   * makes this a fresh Matrix device with no history it can read. Keeping the
   * same one across launches is therefore a matter of persisting the session,
   * which see: {@link AlloSession}.
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
 * best storage the platform has — the device keychain on a phone, and on web the
 * origin's own, which is all a browser offers and is the same protection the
 * crypto store already relies on.
 *
 * A warning that matters more under OIDC than it did under a password: **these
 * tokens rotate**. The SDK refreshes them on its own, without being asked, and a
 * copy taken at login is correct for minutes and stale for good afterwards — a
 * session that looks persisted and quietly stops restoring.
 * {@link AlloChatClient.observeSession} is how an app hears about it, and
 * anything that stores a session has to subscribe to it.
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
 * How far this device has got with Matrix's server-side secret storage (4S) and
 * the key backup that hangs off it.
 *
 * These four values describe **this device**, not the account. `enabled` is not
 * "the server has a backup", it is "the server has one *and* this device holds
 * every secret it needs from it" — which is the question that decides whether
 * old messages are readable here. The native binding answers it directly with
 * `RecoveryState`; the web half assembles the same answer from three calls.
 */
export type AlloRecoveryState =
  /** No 4S on the account. Nobody has ever set recovery up. */
  | 'disabled'
  /** 4S exists, and this device is missing something it holds. */
  | 'incomplete'
  /** This device has everything. Old messages are readable and it is verified. */
  | 'enabled'
  /**
   * Not settled yet. The crypto stack starts up in the background and cannot
   * answer until it has; the honest report is that the question is still open,
   * because acting on a guess here either creates a second 4S store or skips a
   * recovery the device needed.
   */
  | 'unknown';

/* ---------------------------------------------------------------------------
 * Ephemeral conversations
 *
 * Allo's third chat tier. It was specified as "secret" — a room whose keys never
 * leave the devices present — and that room cannot be built on Matrix: the key
 * backup is per account and takes no room id, and any other Matrix client signed
 * into the same account uploads the keys regardless of what Allo does. So the
 * tier was redefined around the one thing the protocol *can* be made to do: if
 * the content stops existing, holding the key is worth nothing. See
 * `docs/matrix/ephemeral.md` for what that buys and — at greater length — what
 * it does not.
 *
 * Two mechanisms, and they are of very different strengths, which is why they
 * are separate types below:
 *
 * - {@link AlloEphemeralPolicy} — a lifetime after which this device redacts its
 *   own messages and stops drawing everyone else's. Redaction is real and
 *   server-side; the hiding is cooperative and a modified client defeats it.
 * - {@link AlloRoomTrust} — what this device knows about the cryptographic
 *   identity of everyone in the room. An ephemeral conversation refuses to send
 *   when it is not satisfied, and *that* refusal is enforced: nothing leaves the
 *   device, so no room key is shared for it either.
 * ------------------------------------------------------------------------- */

/**
 * How long a message lives in an ephemeral conversation.
 *
 * A record with one field rather than a bare number, because a policy is a
 * document written into account data and read back from a server: giving it a
 * name makes the place where it is validated obvious, and leaves room for a
 * second field without changing every signature.
 *
 * **The policy is this account's, not the room's.** Nothing in Matrix that both
 * halves of this port can reach carries it to the other participants — the
 * native binding has no API for a custom room state event, and `StateEventType`
 * is a closed enum of spec'd types — so it is stored in the viewer's own global
 * account data. It therefore reaches the viewer's other devices and nobody
 * else's. Consequences, all of them, in `docs/matrix/ephemeral.md` §3.
 */
export interface AlloEphemeralPolicy {
  /** Milliseconds from a message being sent to it expiring. Always positive. */
  readonly lifetimeMs: number;
}

/**
 * What this device knows about somebody's cross-signing identity.
 *
 * Four values, and the distance between the first two is the whole reason this
 * is not a boolean. `verified` is a signature this account made after checking
 * the other person out of band; `pinned` is trust on first use and nothing more.
 * Allo has no interactive verification flow yet, so in practice nobody is ever
 * `verified` today — which is stated here rather than hidden, because a UI that
 * said "verified" about `pinned` would be describing a check nobody performed.
 */
export type AlloIdentityTrust =
  /** This account has signed their master key. */
  | 'verified'
  /** Their identity is known here and has not changed since it was first seen. */
  | 'pinned'
  /**
   * Their identity was verified before and is not the same one now.
   *
   * The state that has to stop a send: it is what a homeserver substituting a
   * different identity looks like from here.
   */
  | 'changed'
  /**
   * No cross-signing identity at all: they have never published one, or this
   * device has not been able to fetch it.
   */
  | 'unknown';

/** Somebody in a room, and how far their identity is trusted here. */
export interface AlloMemberTrust {
  readonly userId: string;
  readonly trust: AlloIdentityTrust;
}

/**
 * The cryptographic standing of a room, for the tier that depends on it.
 *
 * `ownDevice` is about *this* device and not about the account: a device that
 * has not taken the cross-signing keys out of 4S cannot be trusted by anybody
 * else, so a conversation that promises the participants are checked cannot
 * start from one.
 *
 * A snapshot and not a subscription, for the same reason {@link
 * AlloChatClient.roomDetails} is one: both SDKs answer this cheaply and neither
 * offers one stream shaped the same way. It is read before a send, and by the
 * screen that shows who is in the room.
 */
export interface AlloRoomTrust {
  readonly ownDevice: 'verified' | 'unverified' | 'unknown';
  /** Everyone in the room, the viewer included, in the order the room lists them. */
  readonly members: readonly AlloMemberTrust[];
}

/* ---------------------------------------------------------------------------
 * Push notifications
 *
 * On Matrix the **homeserver owns the pusher registry**. A device registers
 * itself once, and from then on the homeserver decides which events deserve a
 * notification and posts them to a push gateway with the device's token inside
 * the request. Allo's backend therefore holds no table of device tokens at all —
 * see `docs/matrix/push.md`.
 *
 * What the port owes the app is a way to register and to stop; what it owes the
 * *user* is the guarantee below about format.
 * ------------------------------------------------------------------------- */

/** What identifies a pusher on the homeserver. The pair is its primary key. */
export interface AlloPusherIdentity {
  /**
   * Which application this token belongs to, in reverse-DNS.
   *
   * It is what tells the gateway which provider owns the `pushkey`, so it is per
   * platform and it is not a display string. Allo's backend supplies it rather
   * than the app carrying a constant, because the backend is the half that knows
   * which app ids it can actually deliver for.
   */
  readonly appId: string;
  /**
   * The device token the operating system issued: an APNs token, or an FCM
   * registration token.
   *
   * Not a secret in the cryptographic sense, but it addresses one person's
   * phone: never log it, and never send it anywhere but the homeserver and the
   * endpoint that mints this device's gateway URL.
   */
  readonly pushkey: string;
}

/**
 * Text the gateway shows when it has nothing else to show.
 *
 * The gateway genuinely has nothing else, and that is the design working rather
 * than failing: Allo's rooms are encrypted and its pushers ask for
 * `event_id_only`, so the notification that reaches the server names an event
 * and never says what is in it. It also does not know what language to write in.
 * The app knows both, so it says once — here, at registration — what its user
 * should read on the lock screen.
 */
export interface AlloPusherFallbackNotification {
  readonly title: string;
  readonly body: string;
}

/**
 * A pusher to register.
 *
 * **There is no field for the notification format, and there must never be
 * one.** Every pusher this port registers asks the homeserver for
 * `event_id_only`, which is what keeps message plaintext off Allo's servers: the
 * alternative format sends the event's content, the sender and the room's name
 * to the gateway on every message, and in an unencrypted room that content is
 * the message itself. A parameter here would be the way one screen, one refactor
 * or one default argument turns that off — and nothing in the app would look any
 * different afterwards, because the notification would still arrive. Same rule,
 * and the same reason, as {@link AlloOutgoingAttachment} having no "encrypt
 * this" option.
 */
export interface AlloPusher extends AlloPusherIdentity {
  /**
   * Where the homeserver sends the notification.
   *
   * Minted per device by Allo's backend and carrying a capability token bound to
   * this `pushkey`, which is what stops the gateway from being an open relay
   * aimed at users' phones. A credential of sorts: never log it.
   */
  readonly gatewayUrl: string;
  /** Shown in the user's list of devices on other clients. */
  readonly appDisplayName: string;
  readonly deviceDisplayName: string;
  /** The reader's language, as a BCP-47 tag. */
  readonly lang: string;
  readonly fallbackNotification: AlloPusherFallbackNotification;
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

/**
 * Deletes what a client built on a store would otherwise inherit.
 *
 * Separate from {@link AlloChatClient.logout} because it has to be callable when
 * there is no client: a store left behind by a session that is gone has to be
 * erased *before* the next client opens it, and the SDKs' own stores hold one
 * user each — the native one says so outright, that its paths "must be unique per
 * session". Handing a new session a store that belongs to an older one is the
 * failure that does not look like its cause.
 *
 * Erasing a store nothing has written is not an error.
 */
export type AlloChatStoreEraser = (store: AlloClientStore) => Promise<void>;

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
 * A live view of one conversation, plus the operations that only make sense with
 * it open.
 *
 * Sending lives here and not on the client because in the Rust binding sending
 * *is* a timeline operation — `Room` has no send method — and a message's local
 * echo belongs to the timeline that produced it. The message operations below it
 * followed for the same reason and one more: every one of them is something the
 * user does to a message they are looking at, so a caller that can name the event
 * necessarily has the timeline open.
 *
 * All of them take an **event id** rather than an {@link AlloEventKey}. A row
 * still on its way out has no event id, and nothing here can act on one; see
 * `MatrixEventNotSentError` in `errors.ts` for why both platforms refuse rather
 * than one of them trying.
 *
 * **The four operations that put a new encrypted event in the room — {@link
 * sendText}, {@link sendAttachment}, {@link edit} and {@link toggleReaction} —
 * refuse in an ephemeral conversation whose participants this device cannot
 * vouch for.** They reject with `MatrixEphemeralUntrustedError` and nothing
 * leaves the device, which is also what stops the room key being shared for
 * them. {@link redact} is deliberately not among them: it is what removes
 * content, and a rule that blocked it would keep content alive to protect it.
 * Read receipts and typing notices are not among them either — neither carries
 * anything of the conversation, and neither is encrypted.
 */
export interface AlloTimelineHandle {
  /** The current items, oldest first. The array is replaced, never mutated. */
  items(): readonly AlloTimelineItem[];
  /** Asks for up to `count` older events. */
  paginateBackwards(count: number): Promise<AlloPaginationOutcome>;
  /** Sends plain text. The body is sent verbatim; it is not parsed as markdown. */
  sendText(body: string): Promise<void>;

  /**
   * Uploads an attachment and sends the event that points at it.
   *
   * **In an encrypted room the bytes are encrypted before they leave the
   * device, and this call is what guarantees it.** Whether to encrypt is read
   * from the room, here, and not passed in: see
   * {@link AlloOutgoingAttachment} for why there is no parameter for it.
   *
   * It **refuses to send** when the room's encryption state is
   * {@link AlloEncryptionState `'unknown'`} — the state a room is in before
   * sync has delivered `m.room.encryption`. That is the only safe reading of
   * "not known yet": guessing `unencrypted` uploads a photograph in the clear,
   * and the user has no way to tell that happened. Waiting a moment and trying
   * again is the recovery, and it is the caller's.
   *
   * Resolves once the homeserver has the event. On iOS and Android the SDK's
   * send queue owns the upload, so a failure after this resolves shows up as a
   * failed row rather than a rejected promise; on web there is no queue and
   * everything fails here.
   */
  sendAttachment(attachment: AlloOutgoingAttachment): Promise<void>;

  /**
   * Adds the viewer's reaction, or takes it away if it is already there.
   *
   * One call and not two, because the protocol operation is not symmetric —
   * adding sends an `m.annotation`, removing redacts the one that was sent — and
   * only the client holding the timeline knows which of its own annotations to
   * redact. A caller that tried to choose would be choosing from a snapshot that
   * may be one sync behind.
   */
  toggleReaction(eventId: string, key: string): Promise<void>;

  /**
   * Replaces the body of a message the viewer sent.
   *
   * The original event stays on the homeserver and this is a new event pointing
   * at it, which is why the row keeps its identity and its timestamp and only
   * `isEdited` changes.
   */
  edit(eventId: string, body: string): Promise<void>;

  /**
   * Removes an event's content, which is what Matrix has instead of deleting.
   *
   * **The row does not go away.** A redaction strips the content and leaves the
   * skeleton — sender, timestamp, position — standing, on this device and on
   * everyone else's, and that is the protocol working rather than failing. It is
   * why {@link AlloEventContent} has a `redacted` state at all: the UI has to be
   * able to draw "this was deleted" and it must not draw it as an empty bubble
   * or, worse, drop the row and renumber the conversation under the reader.
   *
   * `reason` is sent to the homeserver and is visible to everyone in the room.
   */
  redact(eventId: string, reason: string | undefined): Promise<void>;

  /**
   * Tells the homeserver the viewer has read up to and including this event.
   *
   * A Matrix receipt is a high-water mark, not a per-message flag: it names one
   * event and covers everything before it. Sending one for an event older than
   * the last one sent is therefore not an error and not a correction — the
   * homeserver keeps the newer mark — so a caller may send freely as the reader
   * scrolls.
   */
  sendReadReceipt(eventId: string): Promise<void>;

  /**
   * Says whether the viewer is typing in this room.
   *
   * The homeserver expires the notice on its own after a few seconds, so `true`
   * has to be repeated while the user keeps typing and `false` is a courtesy
   * rather than a requirement. Nothing is retried: a typing notice that did not
   * arrive is worth nothing by the time it could be sent again.
   */
  sendTypingNotice(isTyping: boolean): Promise<void>;

  /**
   * Reports who else is typing in this room, whenever it changes.
   *
   * Changes only, and the viewer is never in the list. The state before the
   * first call is nobody: a room nobody has typed in reports nothing, and there
   * is nothing to report anyway.
   */
  observeTyping(onChange: (userIds: readonly string[]) => void): AlloUnsubscribe;

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
 * - the three recovery calls need a session, and nothing more. They are about
 *   this device's encryption keys, not about the room list, so they do not wait
 *   for sync — which is what lets recovery finish before the first timeline is
 *   drawn, and the messages in it be readable when it is.
 * - {@link logout} is terminal. A client that has logged out holds neither a
 *   session nor a store; signing in again means building a new one.
 *
 * There is no password login and there will not be one. Allo's homeserver issues
 * sessions through Matrix Authentication Service with Oxy upstream, so the user
 * never has a Matrix password to give.
 *
 * **Two operations both SDKs offer are missing on purpose.** `resetRecoveryKey`
 * and `recoverAndReset` each replace the 4S key with 32 random bytes and strip
 * the passphrase block out of the account data. Neither fails, neither warns,
 * and after either one the passphrase derived from the user's Oxy identity stops
 * opening anything — the link that this port exists to maintain is gone, and the
 * only way back is a key nobody was ever shown. They are absent from this
 * interface so that no screen can reach them, and
 * `__tests__/matrix/recovery/noSilentReset.test.ts` fails if an implementation
 * calls one anyway. Changing the recovery key is
 * {@link AlloChatClient.enableRecovery} with a newly derived passphrase, which
 * keeps the link. See `docs/matrix/client-strategy.md` §3.2.
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
  /**
   * Reports the session every time the SDK replaces it.
   *
   * Changes only. The session a login or a restore produced is that call's own
   * result; this is what happens to it afterwards, which under OIDC is a token
   * rotation the app never asked for. See {@link AlloSession} for why an app that
   * persists sessions cannot skip this.
   *
   * Both SDKs report it through a callback the client is built with, so
   * subscribing late does not miss a rotation that has already been applied —
   * what it misses is being *told* about it, and {@link session} still answers
   * with the current one.
   */
  observeSession(onChange: (session: AlloSession) => void): AlloUnsubscribe;

  /**
   * Ends the session, and destroys everything it left on this device.
   *
   * Two halves that fail independently, and the order is the point. The
   * homeserver is asked to forget the device first, so that the tokens stop
   * working; the local stores go afterwards and go *regardless*, because a user
   * signing out on a train has still signed out. A homeserver that could not be
   * reached is reported by the implementation's logs, not by throwing: a caller
   * that saw this throw would have no way to tell "you are still signed in" from
   * "you are signed out and the server does not know yet", and only the second
   * one is true.
   *
   * What must not survive: the access and refresh tokens, the state store, and
   * the crypto store with this device's keys. Half of that is worse than none —
   * the next login opens a crypto store belonging to a device that no longer
   * exists, and fails in ways that look nothing like their cause.
   */
  logout(): Promise<void>;

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
   * Creates a conversation, and answers with its room id.
   *
   * Every room Allo creates is private, invite-only and encrypted; see
   * {@link AlloCreateRoomRequest} for why none of that is a parameter.
   *
   * **A direct message with one invitee reuses the room that already exists with
   * that person, if there is one.** Two people have one conversation, and the
   * homeserver will happily mint a second room between the same pair every time
   * it is asked — which is a second thread of history that neither of them can
   * see from the other. What "already exists" means is what `m.direct` says and
   * what sync has delivered, so a client that has just started may not know about
   * a room it will know about a moment later; the alternative is refusing to
   * create anything until sync settles.
   *
   * The room id comes back before sync has delivered the room, so it will not be
   * in {@link observeRooms}'s list yet and {@link openTimeline} on it may still
   * throw.
   */
  createRoom(request: AlloCreateRoomRequest): Promise<string>;

  /**
   * Joins a room the viewer has been invited to.
   *
   * The other half of {@link createRoom}: creating a conversation invites the
   * people in it, and an invitation is not a conversation until it is accepted.
   * Until then the room has no readable timeline — which is why
   * {@link AlloRoomSummary.membership} exists, and why a UI that could show an
   * invitation but not accept one would be showing a conversation nobody can
   * ever open.
   *
   * Joining an encrypted room does **not** make its earlier messages readable:
   * the keys for those were shared with the devices in the room at the time,
   * and this device was not one of them. What arrives after the join is
   * readable, which is what everybody in the room expects of somebody who has
   * just been let in.
   */
  acceptInvitation(roomId: string): Promise<void>;

  /**
   * Leaves a room: refusing an invitation and walking out of a conversation.
   *
   * **One call for both**, because Matrix has one operation for both — the same
   * `leave` endpoint, the same resulting membership. Two methods here would be
   * two names for one request, and the difference between them is what the
   * screen that called it was showing, which is not the port's business.
   *
   * Leaving is visible to the room. The membership becomes `leave` and everyone
   * in it can see so; there is no way to leave, or to decline, privately, and
   * pretending otherwise would be a promise the protocol does not keep.
   *
   * What it does not do is delete anything. The room stays on the homeserver
   * for the people still in it, this device keeps whatever it had decrypted,
   * and rejoining is possible only by being invited again — an Allo room is
   * invite-only, which is the point.
   */
  leaveRoom(roomId: string): Promise<void>;

  /**
   * Who is in a room, and what the viewer is allowed to do about it.
   *
   * One call rather than three, because all of it is read from the same room
   * state and a screen that showed members from one moment and permissions from
   * another would draw a button whose enabled-ness disagreed with the list
   * beside it.
   *
   * A snapshot, not a subscription. It is read when a screen asks and again
   * after that screen changes something, which is what the port can promise
   * cheaply on both platforms; a change made from another device shows up the
   * next time it is asked for. See `docs/matrix/ui-wiring.md` §9.
   */
  roomDetails(roomId: string): Promise<AlloRoomDetails>;

  /**
   * Invites one person to a room that already exists.
   *
   * One person per call because that is what the protocol has — there is no
   * bulk invite — so a caller inviting three people makes three requests, any
   * of which can fail on its own. Collapsing them here would have to either
   * hide the ones that worked or fail the ones that did.
   *
   * The invitation is what the other person sees; nobody is added to a room by
   * being invited to it. See {@link acceptInvitation}.
   */
  inviteToRoom(roomId: string, userId: string): Promise<void>;

  /**
   * Renames a room.
   *
   * `m.room.name` is a state event, and **state events are not encrypted**
   * (`docs/matrix/data-model.md` §4): the name is readable by the homeserver,
   * unlike everything said inside the room. That is a property of Matrix rather
   * than of this call, and the reason Allo does not put anything but a title
   * here.
   *
   * Whether the viewer may do this at all is
   * {@link AlloRoomRights.canRename}; a homeserver that refuses answers with a
   * `M_FORBIDDEN` this rejects with.
   */
  renameRoom(roomId: string, name: string): Promise<void>;

  /**
   * The authoritative encryption state of a room, asking the server when sync
   * has not settled it locally.
   */
  roomEncryption(roomId: string): Promise<AlloEncryptionState>;

  openTimeline(
    roomId: string,
    onChange: (items: readonly AlloTimelineItem[]) => void,
  ): Promise<AlloTimelineHandle>;

  /**
   * Fetches an attachment's bytes and answers with something a view can show.
   *
   * **Decryption happens here**, when the ref names media from an encrypted
   * room, which is why this exists at all instead of the port handing out URLs:
   * what the homeserver serves at the underlying address is ciphertext, and a
   * view given that address draws a broken image. See {@link AlloMediaRef}.
   *
   * On the client rather than on the timeline because a ref names bytes, not a
   * room: a conversation can be closed while a picture from it is still open.
   * The caller owns the result and must {@link AlloMediaFile.release} it.
   */
  downloadMedia(ref: AlloMediaRef): Promise<AlloMediaFile>;

  /**
   * How far this device has got with 4S. See {@link AlloRecoveryState}.
   *
   * Asynchronous on both platforms even though the native binding answers
   * synchronously, because the answer is only worth having once the crypto
   * stack has finished starting, and waiting for that is the implementation's
   * job rather than every caller's.
   */
  recoveryState(): Promise<AlloRecoveryState>;

  /**
   * Creates 4S and the key backup for this account, unlocked by `passphrase`.
   *
   * Only correct in state `disabled`. Calling it when 4S already exists creates
   * a *second* store and makes it the default, which abandons the first one and
   * every secret in it — the native SDK reallocates the key outright, and the
   * web SDK is no kinder. {@link ensureMatrixRecovery} is what enforces that,
   * and it is the only intended caller.
   *
   * `passphrase` is a credential: never log it, never persist it, never send it
   * anywhere. Allo derives it from the Oxy identity — see
   * `lib/matrix/recovery/passphrase.ts`.
   */
  enableRecovery(passphrase: string): Promise<void>;

  /**
   * Opens the account's existing 4S with `passphrase` and takes from it
   * everything this device is missing: the cross-signing keys, the key backup
   * decryption key, and then the room keys themselves.
   *
   * Two consequences worth stating because the UI depends on them. Messages
   * that arrived before this device existed become readable — that is the whole
   * point. And the device signs itself with the self-signing key it just
   * recovered, so it ends up cross-signing verified without anyone scanning a QR
   * code or comparing emoji.
   *
   * Only correct in state `incomplete`.
   */
  recoverWithPassphrase(passphrase: string): Promise<void>;

  /**
   * The conversations this account treats as ephemeral, and for how long.
   *
   * Read from the account's own global account data, which sync keeps in the
   * client's local store — so this is a local read and is cheap enough to do
   * before a send. A room with no entry is an ordinary conversation.
   *
   * See {@link AlloEphemeralPolicy} for why this is per account rather than per
   * room, and what that costs.
   */
  ephemeralPolicies(): Promise<ReadonlyMap<string, AlloEphemeralPolicy>>;

  /**
   * Makes a conversation ephemeral, changes how long its messages live, or
   * makes it ordinary again with `undefined`.
   *
   * Read-modify-write over one account data event, so two devices changing
   * different rooms at the same instant can lose one of the two changes. That
   * is the same race `docs/matrix/data-model.md` §4.3 describes for an archived
   * list, and it is accepted for the same reason: the alternative is one account
   * data event per room, which is a per-room key the homeserver would see the
   * name of anyway.
   *
   * **Turning it off does not bring anything back.** What has already been
   * redacted is gone from the homeserver for everyone, and no client can undo a
   * redaction.
   */
  setEphemeralPolicy(roomId: string, policy: AlloEphemeralPolicy | undefined): Promise<void>;

  /**
   * What this device knows about the identity of everyone in a room.
   *
   * The check an ephemeral conversation refuses to send without. It is read
   * from the crypto store — the identities of people in an encrypted room are
   * tracked there — and falls back to asking the homeserver for somebody it has
   * never seen, because "I have not looked" and "they have published nothing"
   * are different answers and only the second one should stop a message.
   */
  roomTrust(roomId: string): Promise<AlloRoomTrust>;

  /**
   * Tells the homeserver to notify this device.
   *
   * Idempotent by construction: a pusher is identified by its `app_id` and
   * `pushkey`, so registering the same pair again replaces the record rather than
   * adding one. That is what makes it safe — and correct — to do on every launch,
   * which is also necessary: device tokens are reissued by the operating system
   * without warning, and a pusher holding the previous one is a phone that has
   * quietly stopped ringing.
   *
   * Needs a session and nothing else. It does not wait for sync, because a
   * notification is the homeserver's business and not this device's view of the
   * room list.
   *
   * See {@link AlloPusher} for the one thing that is deliberately not a
   * parameter.
   */
  registerPusher(pusher: AlloPusher): Promise<void>;

  /**
   * Tells the homeserver to stop notifying this device.
   *
   * Must happen **before** {@link logout}: the call needs the access token that
   * logging out destroys. A pusher left behind on the homeserver keeps a device
   * token that now belongs to nobody, and the notifications it produces arrive on
   * a phone that has signed out.
   *
   * Removing a pusher that is not there is not an error.
   */
  unregisterPusher(identity: AlloPusherIdentity): Promise<void>;

  /** Stops sync and releases every handle this client handed out. */
  close(): Promise<void>;
}

/** Builds a client. Resolved per platform; see the note at the top of this file. */
export type AlloChatClientFactory = (
  config: AlloChatClientConfig,
) => Promise<AlloChatClient>;
