import type { Conversation } from '@/app/(chat)/index';
import type { AlloRoomSummary, AlloTimelineItem } from '@/lib/matrix/types';
import type { Message } from '@/stores/messagesStore';

/**
 * The port's view model, translated into the one Allo's chat components draw.
 *
 * This module exists so that `MessageBubble`, `MessageBlock`, the conversation
 * row and the three-panel layout do not have to learn what a room is. They keep
 * taking `Conversation` and `Message`; only where those come from changes.
 *
 * It is pure and takes its words as arguments, so the mapping can be tested
 * without React, without i18n and without a homeserver.
 */

/**
 * What to say about an event that has no text of its own.
 *
 * Three of the port's four content kinds carry no body, and each is a different
 * fact about the world. They must not collapse into an empty bubble: an event
 * that arrived and cannot be read is not the same as one that never arrived, and
 * a device set up today sees the unreadable one for every message sent before it
 * existed.
 */
export interface UnreadableEventLabels {
  /** It arrived, and this device has no key that opens it. */
  readonly undecryptable: string;
  /** It was removed, by its sender or by a moderator. */
  readonly redacted: string;
  /** Allo does not draw this kind of event yet. Given the kind's name. */
  readonly unsupported: (description: string) => string;
}

/**
 * A room, as a row of the conversation list.
 *
 * Two of `Conversation`'s fields cannot be filled from what the port reports, and
 * they are left empty rather than invented:
 *
 * - `lastMessage`. {@link AlloRoomSummary} carries no latest event. Reading one
 *   would mean opening a timeline per room, which for a list of hundreds is a
 *   timeline per room open at once.
 * - `timestamp`. Nor does it carry an activity time. The *order* of the list is
 *   not lost — the port hands it back already ordered, and this mapping never
 *   re-sorts — but the time shown next to each row is. An empty string is what
 *   `formatConversationTimestamp` renders as nothing, which is the honest answer;
 *   `Date.now()` would put "now" beside every conversation in the app.
 *
 * `theme` is absent for the same kind of reason and is not a gap in the port: a
 * conversation's theme is to be an encrypted timeline event
 * (`docs/matrix/data-model.md` §4.1) and no code writes or reads one yet, so
 * every Matrix conversation falls back to the app's theme.
 */
export function toConversation(summary: AlloRoomSummary): Conversation {
  return {
    id: summary.roomId,
    type: summary.isDirect ? 'direct' : 'group',
    // The room id is a poor name and a better one than nothing: it is what the
    // user sees while sync has not yet delivered the room's name or enough
    // members to compute one.
    name: summary.displayName ?? summary.roomId,
    lastMessage: '',
    timestamp: '',
    unreadCount: summary.unreadCount,
    avatar: summary.avatarUrl,
  };
}

/**
 * A timeline row, as a message bubble.
 *
 * `id` is the port's `key` and not the event id on purpose: it is stable across
 * the moment a message the user just sent stops being a local echo and becomes an
 * event with an id, which is exactly what a list key has to survive.
 */
export function toMessage(
  item: AlloTimelineItem,
  roomId: string,
  labels: UnreadableEventLabels,
): Message {
  return {
    id: item.key,
    text: bodyOf(item, labels),
    senderId: item.sender,
    senderName: item.senderDisplayName,
    timestamp: new Date(item.sentAt),
    isSent: item.isOwn,
    conversationId: roomId,
    messageType: 'user',
    isEncrypted: item.content.kind === 'undecryptable',
    isEdited: item.content.kind === 'text' && item.content.isEdited,
    reactions: toReactions(item),
    readStatus: toReadStatus(item),
  };
}

/**
 * Reactions, in the shape the bubble's vocabulary has: emoji to the user ids who
 * sent it.
 *
 * `undefined` and not an empty object for a message nobody has reacted to. The
 * field is optional in `Message` and the overwhelming majority of rows have no
 * reactions, so this is one fewer object per message per redraw — and the two
 * are already the same thing to every reader of the field.
 */
function toReactions(item: AlloTimelineItem): Message['reactions'] {
  if (item.reactions.length === 0) {
    return undefined;
  }
  const reactions: Record<string, string[]> = {};
  for (const reaction of item.reactions) {
    reactions[reaction.key] = [...reaction.senders];
  }
  return reactions;
}

function bodyOf(item: AlloTimelineItem, labels: UnreadableEventLabels): string {
  switch (item.content.kind) {
    case 'text':
      return item.content.body;
    case 'undecryptable':
      return labels.undecryptable;
    case 'redacted':
      return labels.redacted;
    case 'unsupported':
      return labels.unsupported(item.content.description);
  }
}

/**
 * How far along an outgoing message is, in the vocabulary the bubble has.
 *
 * Only the sender's own messages carry a status: `MessageMetadata` draws nothing
 * for anyone else's, so reporting one would be noise.
 *
 * One of the bubble's five states is unreachable from here, and it is worth
 * naming rather than hiding. **`delivered` never happens.** Matrix has no
 * delivery receipt — there is no event for "it reached their device"
 * (`docs/matrix/data-model.md` §9, `deliveredTo`) — so a message goes from one
 * tick straight to read, and the middle state belongs to the Express backend
 * alone. Inventing it here, by treating "the homeserver has it" as delivery,
 * would put two ticks on a message nobody has received.
 */
function toReadStatus(item: AlloTimelineItem): Message['readStatus'] {
  if (!item.isOwn) {
    return undefined;
  }
  switch (item.sendState) {
    case 'pending':
      return 'pending';
    // Drawn as an error and not as the clock. The clock is honest on iOS and
    // Android, where the Rust SDK's queue really is still retrying, and a lie on
    // the web, where nothing retries and the message is simply gone. One of the
    // two had to be chosen for both, and a message shown as failed that a queue
    // then sends is a surprise the user recovers from; a message shown as
    // pending forever is one they do not.
    case 'failed':
      return 'failed';
    case 'sent':
      return item.isReadByOthers ? 'read' : 'sent';
  }
}
