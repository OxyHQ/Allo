import {
  EncryptionState,
  EventOrTransactionId_Tags,
  EventSendState_Tags,
  Membership,
  MessageType_Tags,
  MsgLikeKind_Tags,
  ProfileDetails_Tags,
  SyncServiceState,
  TimelineItemContent_Tags,
} from '@unomed/react-native-matrix-sdk';
import type {
  EventTimelineItem,
  RoomInfo,
  TimelineItemContent,
} from '@unomed/react-native-matrix-sdk';

import type {
  AlloEncryptionState,
  AlloEventContent,
  AlloEventKey,
  AlloReaction,
  AlloRoomMembership,
  AlloRoomPreview,
  AlloRoomSummary,
  AlloSendState,
  AlloSyncState,
  AlloTimelineItem,
} from '@/lib/matrix/types';

/**
 * Translation from the binding's model to Allo's view model.
 *
 * Everything here is a pure function of SDK records, which is what makes it the
 * part of the native implementation that can be tested without a device.
 */

/**
 * Lookup tables rather than switches, so the compiler — not a code review —
 * notices when the binding gains a variant: a missing key is a type error.
 */
const ENCRYPTION_STATES: Record<EncryptionState, AlloEncryptionState> = {
  [EncryptionState.Encrypted]: 'encrypted',
  [EncryptionState.NotEncrypted]: 'unencrypted',
  [EncryptionState.Unknown]: 'unknown',
};

const MEMBERSHIPS: Record<Membership, AlloRoomMembership> = {
  [Membership.Invited]: 'invited',
  [Membership.Joined]: 'joined',
  [Membership.Left]: 'left',
  [Membership.Knocked]: 'knocked',
  [Membership.Banned]: 'banned',
};

const SYNC_STATES: Record<SyncServiceState, AlloSyncState> = {
  [SyncServiceState.Idle]: 'idle',
  [SyncServiceState.Running]: 'running',
  [SyncServiceState.Terminated]: 'terminated',
  [SyncServiceState.Error]: 'error',
  [SyncServiceState.Offline]: 'offline',
};

export function toEncryptionState(state: EncryptionState): AlloEncryptionState {
  return ENCRYPTION_STATES[state];
}

export function toSyncState(state: SyncServiceState): AlloSyncState {
  return SYNC_STATES[state];
}

/** The fields of `RoomInfo` the conversation list reads. */
export type RoomSummaryFields = Pick<
  RoomInfo,
  | 'id'
  | 'displayName'
  | 'avatarUrl'
  | 'isDirect'
  | 'membership'
  | 'encryptionState'
  | 'numUnreadMessages'
>;

/** The fields of `EventTimelineItem` a conversation *row* reads. */
export type RoomPreviewFields = Pick<
  EventTimelineItem,
  'sender' | 'senderProfile' | 'content' | 'timestamp' | 'isOwn'
>;

/**
 * The row's preview, from the room's latest event.
 *
 * Nothing is filtered here because the binding has already done it: what
 * `Room.latestEvent()` answers with comes from the Rust SDK's latest-event cache,
 * which only ever holds message-like events — a member joining never becomes a
 * room's latest event. The web half has no such cache and has to make the same
 * choice by hand.
 *
 * @param preview the room's latest event, or `undefined` when it has none. A
 * room this device has seen no message in is not a room whose preview is empty.
 */
export function toRoomPreview(preview: RoomPreviewFields): AlloRoomPreview {
  return {
    // `Timestamp` is milliseconds since the epoch as a bigint, exact as a number
    // for another 285 000 years.
    sentAt: Number(preview.timestamp),
    sender: preview.sender,
    senderDisplayName: toSenderDisplayName(preview.senderProfile),
    isOwn: preview.isOwn,
    content: toEventContent(preview.content),
  };
}

export function toRoomSummary(
  info: RoomSummaryFields,
  preview: RoomPreviewFields | undefined,
): AlloRoomSummary {
  return {
    roomId: info.id,
    displayName: info.displayName,
    avatarUrl: info.avatarUrl,
    isDirect: info.isDirect,
    membership: MEMBERSHIPS[info.membership],
    encryption: toEncryptionState(info.encryptionState),
    unreadCount: Number(info.numUnreadMessages),
    latestMessage: preview === undefined ? undefined : toRoomPreview(preview),
  };
}

/** The fields of `EventTimelineItem` a conversation row reads. */
export type TimelineEventFields = Pick<
  EventTimelineItem,
  | 'eventOrTransactionId'
  | 'sender'
  | 'senderProfile'
  | 'content'
  | 'timestamp'
  | 'isOwn'
  | 'localSendState'
  | 'readReceipts'
>;

/**
 * @param key identity of the row within its timeline, from the SDK's own list
 * identity, so that a local echo and the remote event it becomes are one row.
 *
 * `isReadByOthers` is left `false` here and settled by the projection. It is the
 * one field of a row that is not a function of that row: a receipt sitting on a
 * later message is what says this one was read, so the answer needs the whole
 * timeline and this function has one event. See `lib/matrix/readReceipts.ts`.
 */
export function toTimelineItem(
  key: string,
  event: TimelineEventFields,
): AlloTimelineItem {
  return {
    key,
    id: toEventKey(event.eventOrTransactionId),
    sender: event.sender,
    senderDisplayName: toSenderDisplayName(event.senderProfile),
    // `Timestamp` is milliseconds since the epoch as a bigint. It stays exact as
    // a number for another 285 000 years.
    sentAt: Number(event.timestamp),
    isOwn: event.isOwn,
    sendState: toSendState(event.localSendState),
    content: toEventContent(event.content),
    reactions: toReactions(event.content),
    isReadByOthers: false,
  };
}

/**
 * The user ids whose read receipt names this event.
 *
 * The binding hands over a map keyed by user id, and the keys are the whole
 * answer: what each `Receipt` carries beyond that is a timestamp and a thread
 * id, and neither changes whether the message was read.
 */
export function toReaders(
  event: Pick<TimelineEventFields, 'readReceipts'>,
): readonly string[] {
  return [...event.readReceipts.keys()];
}

const NO_REACTIONS: readonly AlloReaction[] = [];

/**
 * The reactions on a row.
 *
 * Only message-like events carry them — a state event has no annotations — and
 * the binding says so in the shape: `reactions` lives on `MsgLikeContent` and
 * not on `TimelineItemContent`. Reactions on an undecryptable or redacted event
 * survive, which is right: an emoji on a message this device cannot read is
 * still a fact about the conversation.
 */
export function toReactions(content: TimelineItemContent): readonly AlloReaction[] {
  if (content.tag !== TimelineItemContent_Tags.MsgLike) {
    return NO_REACTIONS;
  }
  const reactions = content.inner.content.reactions;
  if (reactions.length === 0) {
    // The common case by a wide margin, and worth not allocating for: this runs
    // once per row per batch, and a batch arrives on every event received.
    return NO_REACTIONS;
  }
  return reactions.map((reaction) => ({
    key: reaction.key,
    // The binding carries a timestamp per sender that Allo has nothing to draw
    // with, and one sender can appear only once per key.
    senders: reaction.senders.map((sender) => sender.senderId),
  }));
}

function toEventKey(id: EventTimelineItem['eventOrTransactionId']): AlloEventKey {
  switch (id.tag) {
    case EventOrTransactionId_Tags.EventId:
      return { kind: 'remote', eventId: id.inner.eventId };
    case EventOrTransactionId_Tags.TransactionId:
      return { kind: 'local', transactionId: id.inner.transactionId };
  }
}

function toSenderDisplayName(
  profile: EventTimelineItem['senderProfile'],
): string | undefined {
  return profile.tag === ProfileDetails_Tags.Ready ? profile.inner.displayName : undefined;
}

/**
 * An event with no local send state is one the homeserver already has: local
 * state only exists while an event of ours is on its way out.
 */
function toSendState(state: EventTimelineItem['localSendState']): AlloSendState {
  if (state === undefined) {
    return 'sent';
  }
  switch (state.tag) {
    case EventSendState_Tags.NotSentYet:
      return 'pending';
    case EventSendState_Tags.SendingFailed:
      return 'failed';
    case EventSendState_Tags.Sent:
      return 'sent';
  }
}

export function toEventContent(content: TimelineItemContent): AlloEventContent {
  if (content.tag !== TimelineItemContent_Tags.MsgLike) {
    // Membership changes, profile changes, call invites, state events: real
    // events that Allo does not draw yet. They are reported as themselves rather
    // than dropped, so a gap in a conversation is visible instead of silent.
    return { kind: 'unsupported', description: content.tag };
  }

  const kind = content.inner.content.kind;
  switch (kind.tag) {
    case MsgLikeKind_Tags.Message: {
      const message = kind.inner.content;
      if (message.msgType.tag !== MessageType_Tags.Text) {
        // An image's `body` is its filename. Drawing it as the message text would
        // be worse than admitting the row is not drawable yet.
        return { kind: 'unsupported', description: `m.room.message:${message.msgType.tag}` };
      }
      return { kind: 'text', body: message.body, isEdited: message.isEdited };
    }

    case MsgLikeKind_Tags.UnableToDecrypt:
      // The event arrived and carries no readable content at all — there is no
      // `body` to fall back on. This is a state, not missing data.
      return { kind: 'undecryptable' };

    case MsgLikeKind_Tags.Redacted:
      return { kind: 'redacted' };

    case MsgLikeKind_Tags.Sticker:
    case MsgLikeKind_Tags.Poll:
    case MsgLikeKind_Tags.Other:
      return { kind: 'unsupported', description: kind.tag };
  }
}
