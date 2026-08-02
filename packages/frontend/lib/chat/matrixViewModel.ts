import type { Conversation } from '@/app/(chat)/index';
import type {
  AlloEventContent,
  AlloMediaContent,
  AlloRoomSummary,
  AlloTimelineItem,
} from '@/lib/matrix/types';
import type {
  MediaItem,
  Message,
  MessageAttachment,
  MessageAttachmentKind,
} from '@/stores/messagesStore';

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
  /**
   * Its conversation is ephemeral and it is past its lifetime, so this device
   * has stopped drawing it.
   *
   * A different sentence from {@link redacted} because it is a different — and
   * weaker — fact: the content is gone from *here*, and whether it is gone from
   * the homeserver depends on its sender's client having been running. Saying
   * "deleted" would promise the stronger one. See `docs/matrix/ephemeral.md`.
   */
  readonly expired: string;
  /** Allo does not draw this kind of event yet. Given the kind's name. */
  readonly unsupported: (description: string) => string;
  /**
   * An attachment in a **conversation row** that has no caption.
   *
   * Separate from {@link attachment} because the two places want opposite
   * things. A picture in a bubble should say nothing; the same picture as a
   * conversation's latest message must say "Photo", or the row goes blank and
   * reads as a conversation nobody has written in — which is the mistake this
   * whole mapping is shaped to prevent.
   */
  readonly mediaPreview: (kind: AlloMediaContent['kind']) => string;
}

/**
 * A room, as a row of the conversation list.
 *
 * **A row with no known time says nothing, and must be able to.** A room whose
 * latest message this device does not know — an invitation, a conversation
 * created a moment ago, one whose history has not arrived — has no preview and no
 * time, and both come out empty. `formatConversationTimestamp` renders an empty
 * string as nothing, which is the honest answer; the current time would put "now"
 * beside every conversation in the app, including one nobody has touched in a
 * year. That is the mistake this mapping is shaped to make impossible: the time
 * is read from the message, so there is no time to invent when there is no
 * message.
 *
 * The *order* of the list is not this mapping's business either way. The port
 * hands it back already ordered and nothing here re-sorts.
 *
 * `theme` is absent, and is not a gap in the port: a conversation's theme is to
 * be an encrypted timeline event (`docs/matrix/data-model.md` §4.1) and no code
 * writes or reads one yet, so every Matrix conversation falls back to the app's
 * theme.
 *
 * `isEphemeral` is an argument and not something read from the summary, because
 * it is not a fact about the room: it is an entry in this account's own account
 * data. See `docs/matrix/ephemeral.md` §3.
 */
export function toConversation(
  summary: AlloRoomSummary,
  labels: UnreadableEventLabels,
  isEphemeral: boolean,
): Conversation {
  const latest = summary.latestMessage;
  return {
    id: summary.roomId,
    type: summary.isDirect ? 'direct' : 'group',
    // The room id is a poor name and a better one than nothing: it is what the
    // user sees while sync has not yet delivered the room's name or enough
    // members to compute one.
    name: summary.displayName ?? summary.roomId,
    lastMessage: latest === undefined ? '' : previewOf(latest.content, labels),
    timestamp: latest === undefined ? '' : new Date(latest.sentAt).toISOString(),
    unreadCount: summary.unreadCount,
    avatar: summary.avatarUrl,
    // An invitation is in the list because the port's definition of a
    // conversation is everything the viewer has not left, and it is not a
    // conversation yet: there is nothing to read in it and accepting comes first.
    // What to do about that is the screen's decision, not this mapping's.
    isInvitation: summary.membership === 'invited',
    // Not read from the room, and it could not be: what makes a conversation
    // ephemeral is an entry in *this account's* account data, so the caller
    // holds the answer and this mapping is told. See
    // `lib/matrix/ephemeral/policy.ts` for why it is not room state.
    isEphemeral,
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
    text: bodyOf(item.content, labels),
    senderId: item.sender,
    senderName: item.senderDisplayName,
    timestamp: new Date(item.sentAt),
    isSent: item.isOwn,
    conversationId: roomId,
    messageType: 'user',
    media: item.content.kind === 'media' ? toMediaItems(item.content.media) : undefined,
    attachment: item.content.kind === 'media' ? toAttachment(item.content.media) : undefined,
    isEncrypted: item.content.kind === 'undecryptable',
    isEdited: item.content.kind === 'text' && item.content.isEdited,
    reactions: toReactions(item),
    readStatus: toReadStatus(item),
  };
}

/**
 * The picture or the video the carousel draws, or `undefined` for an attachment
 * that has none.
 *
 * A list, because `Message.media` is one and `MessageBlock` flattens the group's
 * — but always of length one here: a Matrix event carries a single attachment,
 * and the several-in-one-message case is `m.gallery`, which Allo does not send
 * and reports as unsupported.
 *
 * **The `id` is the port's media ref**, not an identifier of Allo's, and that is
 * what makes the carousel work unchanged: it calls `getMediaUrl(item.id, …)`,
 * and the ref is exactly what `AlloChatClient.downloadMedia` takes. See
 * `lib/chat/mediaCache.ts` for what turns one into a URL.
 *
 * **The thumbnail is preferred over the original whenever the sender made one.**
 * A bubble is 250pt wide and the original is a phone camera's full-resolution
 * photograph; on an encrypted room the sender's thumbnail is the only smaller
 * copy that exists, because a homeserver cannot resize what it cannot read.
 *
 * `fullSizeId` is how the original survives that choice. The viewer opens on it,
 * and without it the ref would be gone by the time anything could ask: the
 * bubble would be the only copy the app ever had, which is why tapping one used
 * to do nothing.
 */
function toMediaItems(media: AlloMediaContent): MediaItem[] | undefined {
  const type = CAROUSEL_TYPE_BY_KIND[media.kind];
  if (type === undefined) {
    return undefined;
  }
  return [
    {
      id: media.thumbnail ?? media.source,
      type,
      // Only when the two differ. Set unconditionally it would say "this row is
      // drawing a smaller copy" about a row that is drawing the original, and
      // the viewer would show a second download of bytes it already has.
      fullSizeId: media.thumbnail === undefined ? undefined : media.source,
      filename: media.filename,
    },
  ];
}

/**
 * An attachment with no picture in it, or `undefined` for one the carousel
 * draws.
 *
 * The two are exclusive by construction: a kind is either in
 * {@link CAROUSEL_TYPE_BY_KIND} or it is here, never both, so no message ever
 * carries `media` and `attachment` at once.
 */
function toAttachment(media: AlloMediaContent): MessageAttachment | undefined {
  const kind = ATTACHMENT_KIND[media.kind];
  if (kind === undefined) {
    return undefined;
  }
  return {
    kind,
    source: media.source,
    filename: media.filename,
    size: media.size,
    durationMs: media.durationMs,
  };
}

/**
 * The three kinds that are drawn as a player or a file row.
 *
 * The complement of {@link CAROUSEL_TYPE_BY_KIND} over `AlloMediaKind`, and
 * written as a keyed record for the same reason: a sixth kind added to the port
 * is a compile error in one of these two tables rather than an attachment that
 * silently draws as nothing.
 */
const ATTACHMENT_KIND: Readonly<Partial<Record<AlloMediaContent['kind'], MessageAttachmentKind>>> =
  {
    audio: 'audio',
    voice: 'voice',
    file: 'file',
  };

/**
 * Which attachments the carousel can draw, and as what.
 *
 * Audio, voice notes and documents are absent because `MediaCarousel` renders
 * nothing for them — it draws images and a still frame for videos — and giving
 * it one would produce an empty bubble. They travel as {@link toAttachment}
 * instead, and are drawn by a player or a file row.
 */
const CAROUSEL_TYPE_BY_KIND: Readonly<Partial<Record<AlloMediaContent['kind'], MediaItem['type']>>> =
  {
    image: 'image',
    video: 'video',
  };

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

/**
 * What an event says in a **bubble**.
 *
 * The three states that carry no text mean the same thing here as in a
 * conversation row, and {@link previewOf} delegates to this for all of them.
 * Only an attachment differs, and it differs completely: see
 * {@link UnreadableEventLabels.mediaPreview}.
 */
function bodyOf(content: AlloEventContent, labels: UnreadableEventLabels): string {
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'media':
      // An attachment says nothing of its own: the bubble *is* the picture, the
      // player or the file row, and every kind now has one of the three. Only a
      // caption is prose, and only a caption gets a bubble.
      return captionOf(content.media) ?? '';
    case 'undecryptable':
      return labels.undecryptable;
    case 'redacted':
      return labels.redacted;
    case 'expired':
      return labels.expired;
    case 'unsupported':
      return labels.unsupported(content.description);
  }
}

/**
 * What an event says in a **conversation row**.
 *
 * A conversation whose last message this device cannot decrypt has to say so in
 * the list as well as in the timeline, and so does one whose last message is a
 * photograph: an empty preview reads as a conversation nobody has written in.
 */
function previewOf(content: AlloEventContent, labels: UnreadableEventLabels): string {
  if (content.kind === 'media') {
    return captionOf(content.media) ?? labels.mediaPreview(content.media.kind);
  }
  return bodyOf(content, labels);
}

/** The sender's own words about an attachment, if they wrote any. */
function captionOf(media: AlloMediaContent): string | undefined {
  return media.caption !== undefined && media.caption !== '' ? media.caption : undefined;
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
