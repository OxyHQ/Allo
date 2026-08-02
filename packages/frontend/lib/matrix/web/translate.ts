import type { IContent, Membership } from 'matrix-js-sdk';

import type {
  AlloEncryptionState,
  AlloEventContent,
  AlloEventKey,
  AlloReaction,
  AlloRoomMembership,
  AlloRoomSummary,
  AlloSendState,
  AlloSyncState,
  AlloTimelineItem,
} from '@/lib/matrix/types';

/**
 * Translation from `matrix-js-sdk`'s model to Allo's view model.
 *
 * Everything here is a pure function of what the SDK's objects answer, which is
 * what makes it the part of the web implementation that can be tested without a
 * browser, a homeserver or 7.8 MB of WebAssembly. The parameter types describe
 * only the members each function reads: `Room`, `MatrixEvent` and `RoomState`
 * satisfy them structurally, so the compiler still checks them at the call site
 * in `client.web.ts`, and a test does not have to build a `MatrixEvent`.
 *
 * The imports above are all `import type`. That is a rule, not an accident: this
 * module must not pull `matrix-js-sdk` into the runtime, or its tests would drag
 * in the whole SDK.
 *
 * Because of that rule the Matrix event types below are spelled out rather than
 * taken from the SDK's `EventType` enum, which is a value. They are protocol
 * constants — they cannot change without the protocol changing.
 */

const ROOM_CREATE_EVENT_TYPE = 'm.room.create';
const ROOM_MESSAGE_EVENT_TYPE = 'm.room.message';
const ROOM_ENCRYPTED_EVENT_TYPE = 'm.room.encrypted';
const ROOM_REDACTION_EVENT_TYPE = 'm.room.redaction';
const REACTION_EVENT_TYPE = 'm.reaction';
const TEXT_MESSAGE_TYPE = 'm.text';
const REPLACE_RELATION_TYPE = 'm.replace';
const READ_RECEIPT_TYPE = 'm.read';
const PRIVATE_READ_RECEIPT_TYPE = 'm.read.private';

/**
 * The SDK's `SyncState` and `EventStatus`, written as the values of their
 * members rather than imported.
 *
 * They are enums, which are values, and importing a value would put the whole
 * SDK behind this module at runtime. Spelling them out costs nothing in safety:
 * an enum member is assignable to the string literal it equals but not the other
 * way round, so if the SDK ever grows a variant these unions do not cover, the
 * error appears where a real `MatrixClient` or `MatrixEvent` is handed to the
 * functions below.
 */
type SdkSyncState = 'PREPARED' | 'SYNCING' | 'CATCHUP' | 'RECONNECTING' | 'ERROR' | 'STOPPED';
type SdkEventStatus = 'not_sent' | 'encrypting' | 'sending' | 'queued' | 'sent' | 'cancelled';

/**
 * Lookup tables rather than switches, so the compiler — not a code review —
 * notices an unhandled variant: a missing key is a type error.
 */
const SYNC_STATES: Record<SdkSyncState, AlloSyncState> = {
  PREPARED: 'running',
  SYNCING: 'running',
  // Both of these mean the connection dropped and the SDK is trying to get it
  // back: CATCHUP is the sync it runs after connectivity returns, RECONNECTING is
  // the attempt to get there. Neither is an error yet — the SDK moves to ERROR
  // once it has failed enough times — and neither is running.
  CATCHUP: 'offline',
  RECONNECTING: 'offline',
  ERROR: 'error',
  STOPPED: 'terminated',
};

const SEND_STATES: Record<SdkEventStatus, AlloSendState> = {
  encrypting: 'pending',
  queued: 'pending',
  sending: 'pending',
  // The homeserver has taken the event but it has not come back down /sync yet.
  // It is on the server, which is what "sent" means to the UI.
  sent: 'sent',
  not_sent: 'failed',
  // Cancelled by the app before it went out. The port has no state for "the user
  // took it back" and inventing one for a case Allo's UI cannot produce would be
  // a member only one implementation can answer.
  cancelled: 'failed',
};

const MEMBERSHIPS: Record<'ban' | 'invite' | 'join' | 'knock' | 'leave', AlloRoomMembership> = {
  ban: 'banned',
  invite: 'invited',
  join: 'joined',
  knock: 'knocked',
  leave: 'left',
};

/**
 * `Membership` is an open string type — the SDK deliberately allows values a
 * future spec might add — so this is a lookup with a miss, not an exhaustive map.
 */
const MEMBERSHIP_LOOKUP: Readonly<Partial<Record<string, AlloRoomMembership>>> = MEMBERSHIPS;

/**
 * The port's sync state, from the SDK's.
 *
 * `null` is the state before the sync loop has ever run, which is the state a
 * caller subscribing before `startSync()` has to be told about.
 */
export function toSyncState(state: SdkSyncState | null): AlloSyncState {
  return state === null ? 'idle' : SYNC_STATES[state];
}

/** What this module needs of a `RoomState`. */
export interface RoomStateFields {
  getStateEvents(eventType: string, stateKey: string): object | null;
}

/** What {@link toEncryptionState} needs of a `Room`. */
export interface RoomEncryptionFields {
  hasEncryptionStateEvent(): boolean;
}

/**
 * Whether a room is encrypted, in three values.
 *
 * The third one is the point. `hasEncryptionStateEvent()` answers with a boolean,
 * so on its own it reports "sync has not delivered this room's state yet" as "not
 * encrypted" — a false negative the UI would draw as an open padlock on an
 * encrypted room, and the normal state of a room that has just been created.
 *
 * What separates the two is whether we hold the room's state at all: every room
 * has exactly one `m.room.create` event in its state, so not being able to see it
 * means the state has not arrived, not that the room is unencrypted.
 */
export function toEncryptionState(
  room: RoomEncryptionFields,
  state: RoomStateFields | undefined,
): AlloEncryptionState {
  if (room.hasEncryptionStateEvent()) {
    return 'encrypted';
  }
  if (state === undefined) {
    return 'unknown';
  }
  return state.getStateEvents(ROOM_CREATE_EVENT_TYPE, '') === null ? 'unknown' : 'unencrypted';
}

/** What the conversation list needs of a `Room`. */
export interface RoomSummaryFields extends RoomEncryptionFields {
  readonly roomId: string;
  readonly name: string;
  getMyMembership(): Membership;
  getMxcAvatarUrl(): string | null;
  /** Called with no argument, which the SDK reads as the total count. */
  getUnreadNotificationCount(): number;
}

/**
 * A room as the conversation list draws it, or `undefined` for a room whose
 * membership this version of Allo has no name for.
 *
 * Dropping it is deliberate. `Membership` is an open string type, so a future
 * spec value would otherwise have to be reported as one of the five the port
 * knows — and a room the user is not really in, shown as joined, is worse than a
 * room missing from the list.
 */
export function toRoomSummary(
  room: RoomSummaryFields,
  state: RoomStateFields | undefined,
  isDirect: boolean,
): AlloRoomSummary | undefined {
  const membership = MEMBERSHIP_LOOKUP[room.getMyMembership()];
  if (membership === undefined) {
    return undefined;
  }
  return {
    roomId: room.roomId,
    // The SDK computes this from `m.room.name` and falls back to the members, and
    // the fallback is the answer the port wants. An empty one is not a name.
    displayName: room.name === '' ? undefined : room.name,
    avatarUrl: room.getMxcAvatarUrl() ?? undefined,
    isDirect,
    membership,
    encryption: toEncryptionState(room, state),
    unreadCount: toUnreadCount(room.getUnreadNotificationCount()),
  };
}

/**
 * The count comes from the homeserver's notification counts, which are computed
 * from push rules rather than from read receipts alone. That is a small
 * divergence from the port's "independent of notification settings", and it is
 * the right trade: counting unread events locally would only count the ones this
 * client has loaded, which after a cold start is a handful of them.
 */
function toUnreadCount(count: number): number {
  return Number.isInteger(count) && count > 0 ? count : 0;
}

/** What a conversation row needs of a `MatrixEvent`. */
export interface TimelineEventFields {
  getId(): string | undefined;
  getTxnId(): string | undefined;
  getSender(): string | undefined;
  getType(): string;
  getContent(): IContent;
  getTs(): number;
  isRedacted(): boolean;
  /** `null` for an event that does not point at another one. */
  getRelation(): { readonly rel_type?: string } | null;
  /** Only its nullness is read: an event with a replacement has been edited. */
  replacingEvent(): object | null;
  /** `null` for every event the homeserver has already accepted. */
  readonly status: SdkEventStatus | null;
  /** The sender's room membership, once the SDK has resolved it. */
  readonly sender: { readonly name: string } | null;
}

/**
 * Whether this event is a row of the conversation at all.
 *
 * Three kinds of event are in the timeline and are not rows, because each one
 * exists to change a row that is already there:
 *
 * - **reactions**, which belong on the message they annotate;
 * - **redactions**, which empty the event they name — that event stays, and
 *   stays a row, which is what makes "deleted" different from "gone";
 * - **edits**, which replace the body of the event they point at. The SDK
 *   already folds the new body into the original, so drawing the replacement as
 *   well would show the message twice, once with a leading `* `.
 *
 * The native SDK never surfaces any of these as timeline items, and this is the
 * web half agreeing. It is not cosmetic: without it, the first reaction Allo
 * sends comes back down sync and draws itself as "Allo cannot show this yet
 * (m.reaction)" underneath the message it was meant to decorate.
 */
export function isTimelineRow(event: TimelineEventFields): boolean {
  const type = event.getType();
  if (type === REACTION_EVENT_TYPE || type === ROOM_REDACTION_EVENT_TYPE) {
    return false;
  }
  // A redacted event has no content left to carry a relation, so this reads the
  // relation of live events only — which is the only place one can be.
  return event.getRelation()?.rel_type !== REPLACE_RELATION_TYPE;
}

/**
 * One row of a conversation, or `undefined` for an event that cannot be
 * addressed.
 *
 * A row needs a sender and a stable identity, and every event the SDK puts in a
 * timeline has both: remote events carry an event id, local echoes carry the
 * transaction id the SDK minted for them. An event with neither is not something
 * to draw a guess for — it is a bug worth seeing — so the caller drops it and
 * says so rather than inventing a key, which would collide with the next one.
 *
 * `isReadByOthers` is left `false` and settled by the caller. It is the one field
 * of a row that is not a function of that row: the receipt that says this message
 * was read normally sits on a later one. See `lib/matrix/readReceipts.ts`.
 */
export function toTimelineItem(
  event: TimelineEventFields,
  viewerUserId: string,
  reactions: readonly AlloReaction[],
): AlloTimelineItem | undefined {
  const sender = event.getSender();
  const identity = toEventIdentity(event);
  if (sender === undefined || identity === undefined) {
    return undefined;
  }
  return {
    key: identity.key,
    id: identity.id,
    sender,
    senderDisplayName: event.sender?.name,
    sentAt: event.getTs(),
    isOwn: sender === viewerUserId,
    sendState: toSendState(event.status),
    content: toEventContent(event),
    reactions,
    isReadByOthers: false,
  };
}

/** What {@link toReactions} needs of the annotation events the SDK aggregated. */
export interface ReactionEventFields {
  getSender(): string | undefined;
  isRedacted(): boolean;
}

const NO_REACTIONS: readonly AlloReaction[] = [];

/**
 * The reactions on one message, from the SDK's aggregation of its annotations.
 *
 * `null` is what the SDK answers for a message nobody has reacted to, and it is
 * the overwhelmingly common case: it is reported as no reactions rather than as
 * an absence, because a message with none and a message whose annotations have
 * not loaded look the same to a reader and there is nothing to draw for either.
 *
 * Two things are dropped. A redacted annotation is a reaction that was taken
 * back — the container usually removes it, and a race where it has not is not a
 * reason to draw it. And a sender is counted once per key however many
 * annotations arrive from them, because the count is of people and the events
 * come from a homeserver, which is to say from outside.
 */
export function toReactions(
  annotations: readonly (readonly [string, ReadonlySet<ReactionEventFields>])[] | null,
): readonly AlloReaction[] {
  if (annotations === null || annotations.length === 0) {
    return NO_REACTIONS;
  }

  const reactions: AlloReaction[] = [];
  for (const [key, events] of annotations) {
    const senders = new Set<string>();
    for (const event of events) {
      const sender = event.getSender();
      if (sender !== undefined && !event.isRedacted()) {
        senders.add(sender);
      }
    }
    if (senders.size > 0) {
      reactions.push({ key, senders: [...senders] });
    }
  }
  return reactions.length === 0 ? NO_REACTIONS : reactions;
}

/** What {@link toReaders} needs of the SDK's cached receipts for one event. */
export interface ReceiptFields {
  readonly type: string;
  readonly userId: string;
}

/**
 * The user ids whose read receipt names this event.
 *
 * `m.fully_read` is filtered out and the two read receipts are kept. A fully-read
 * marker is a private bookmark the user's own client moves around — it says where
 * they stopped, not what they saw — and counting it would let one participant's
 * scroll position mark another participant's message as read.
 */
export function toReaders(receipts: readonly ReceiptFields[]): readonly string[] {
  const readers: string[] = [];
  for (const receipt of receipts) {
    if (receipt.type === READ_RECEIPT_TYPE || receipt.type === PRIVATE_READ_RECEIPT_TYPE) {
      readers.push(receipt.userId);
    }
  }
  return readers;
}

interface EventIdentity {
  /** The list key: stable across the moment a local echo becomes a remote event. */
  readonly key: string;
  readonly id: AlloEventKey;
}

/**
 * How the row addresses itself, and how the list keys it.
 *
 * A local echo is addressable only by its transaction id until the homeserver
 * gives it an event id, and the SDK reflects that: while the event is on its way
 * out `getId()` returns a locally minted placeholder, and it is replaced with the
 * real one the moment the server answers — which is also when the status becomes
 * `sent`.
 *
 * The key is not the same question. The transaction id survives that swap, so
 * preferring it wherever there is one is what makes a message the user just sent
 * one row that changes rather than two rows that replace each other.
 */
function toEventIdentity(event: TimelineEventFields): EventIdentity | undefined {
  const transactionId = event.getTxnId();
  const eventId = event.getId();

  if (toSendState(event.status) === 'sent' && eventId !== undefined) {
    return { key: transactionId ?? eventId, id: { kind: 'remote', eventId } };
  }
  if (transactionId !== undefined) {
    return { key: transactionId, id: { kind: 'local', transactionId } };
  }
  return undefined;
}

function toSendState(status: SdkEventStatus | null): AlloSendState {
  return status === null ? 'sent' : SEND_STATES[status];
}

/**
 * What the row says.
 *
 * The order matters: a redacted event is redacted whether or not it was
 * encrypted, and an encrypted event that has not been decrypted has no content to
 * read at all.
 */
export function toEventContent(event: TimelineEventFields): AlloEventContent {
  if (event.isRedacted()) {
    return { kind: 'redacted' };
  }

  // `getType()` answers with the decrypted type once decryption succeeds, so an
  // event still reporting `m.room.encrypted` is one that arrived and cannot be
  // read — either because it failed to decrypt or because it has not been
  // decrypted yet. Both are the same fact to the UI, and both can stop being true
  // later, when the key for the session turns up.
  if (event.getType() === ROOM_ENCRYPTED_EVENT_TYPE) {
    return { kind: 'undecryptable' };
  }

  if (event.getType() !== ROOM_MESSAGE_EVENT_TYPE) {
    // Membership changes, profile changes, call signalling, state events: real
    // events Allo does not draw yet. They are reported as themselves rather than
    // dropped, so a gap in a conversation is visible instead of silent.
    return { kind: 'unsupported', description: event.getType() };
  }

  const content = event.getContent();
  if (content.msgtype !== TEXT_MESSAGE_TYPE) {
    // An image's `body` is its filename. Drawing it as the message text would be
    // worse than admitting the row is not drawable yet.
    return { kind: 'unsupported', description: `${ROOM_MESSAGE_EVENT_TYPE}:${String(content.msgtype)}` };
  }
  if (typeof content.body !== 'string') {
    // `content` is whatever the homeserver sent, typed by the SDK with an `any`
    // index signature. A text message without a string body is malformed.
    return { kind: 'unsupported', description: `${ROOM_MESSAGE_EVENT_TYPE}:${TEXT_MESSAGE_TYPE}:no-body` };
  }

  return { kind: 'text', body: content.body, isEdited: event.replacingEvent() !== null };
}
