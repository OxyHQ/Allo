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
  Session,
  TimelineItemContent,
} from '@unomed/react-native-matrix-sdk';

import type {
  AlloEncryptionState,
  AlloEventContent,
  AlloEventKey,
  AlloRoomMembership,
  AlloRoomSummary,
  AlloSendState,
  AlloSession,
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

/** The fields of the SDK's session the port carries. */
export type SessionFields = Pick<
  Session,
  'userId' | 'deviceId' | 'homeserverUrl' | 'accessToken' | 'refreshToken' | 'oidcData'
>;

/**
 * `oidcData` becomes the port's opaque `authData`. Under MAS it is not optional
 * detail: it holds what the SDK needs to refresh the tokens, so a session stored
 * without it restores into a client that cannot renew itself.
 */
export function toAlloSession(session: SessionFields): AlloSession {
  return {
    userId: session.userId,
    deviceId: session.deviceId,
    homeserverUrl: session.homeserverUrl,
    accessToken: session.accessToken,
    refreshToken: session.refreshToken,
    authData: session.oidcData,
  };
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

export function toRoomSummary(info: RoomSummaryFields): AlloRoomSummary {
  return {
    roomId: info.id,
    displayName: info.displayName,
    avatarUrl: info.avatarUrl,
    isDirect: info.isDirect,
    membership: MEMBERSHIPS[info.membership],
    encryption: toEncryptionState(info.encryptionState),
    unreadCount: Number(info.numUnreadMessages),
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
>;

/**
 * @param key identity of the row within its timeline, from the SDK's own list
 * identity, so that a local echo and the remote event it becomes are one row.
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
  };
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
