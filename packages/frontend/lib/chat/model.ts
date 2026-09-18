/**
 * WHAT A CHAT SCREEN DRAWS, made from what the SDK reports.
 *
 * `@allo/react` answers with `ConversationView` and `TimelineItemView`; Bloom's
 * chat components take `ChatSummary` and `MessageListItem`, with every name,
 * time and label already a string. These functions are the whole of that
 * translation, pure so a test can hold them still: nothing here talks to a
 * network, a store or React. People arrive through `ChatContext.person`, which
 * the screens back with the people layer (`lib/allo/people.ts`).
 */
import type { ConversationView, MediaView, SendState, TimelineContent, TimelineItemView } from '@allo/core';
import type { MessageDeliveryStatus } from '@oxy.so/bloom/chat-indicators';
import type { ChatPinnedMessage } from '@oxy.so/bloom/chat-screen';
import type { ChatAttachmentKind, ChatFace, ChatPreview, ChatSummary } from '@oxy.so/bloom/chat-list';
import type { MessageListItem, MessageReaction, MessageReplyPreview } from '@oxy.so/bloom/message-bubble';

import type { Person } from '@/lib/allo/people';
import { dayKey, formatDay, formatListTime, formatTime, type Translate } from './format';

export type { Translate };

export interface ChatContext {
  /** The viewer's Oxy account id. */
  me: string | undefined;
  /** Somebody by account id, or `undefined` while they are still being looked up. */
  person: (accountId: string) => Person | undefined;
  t: Translate;
  locale: string;
  now: Date;
}

// ---------------------------------------------------------------------------
// Shared
// ---------------------------------------------------------------------------

const DELIVERY: Record<SendState, MessageDeliveryStatus> = {
  pending: 'sending',
  accepted: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/** How far a message the viewer sent got. `failed` is not a slow `sending`: nothing is trying any more. */
export function deliveryStatus(state: SendState): MessageDeliveryStatus {
  return DELIVERY[state];
}

const ATTACHMENT_KIND: Record<MediaView['kind'], ChatAttachmentKind> = {
  image: 'photo',
  video: 'video',
  audio: 'audio',
  voice: 'voice',
  file: 'file',
};

function attachmentKind(media: MediaView): ChatAttachmentKind {
  return media.kind === 'image' && media.mime === 'image/gif' ? 'gif' : ATTACHMENT_KIND[media.kind];
}

/**
 * The content kinds that are an attachment in a list row without being a file.
 * Bloom draws a glyph for each; a kind that is not here draws plain text.
 */
const ATTACHMENT_CONTENT: Partial<Record<TimelineContent['kind'], ChatAttachmentKind>> = {
  poll: 'poll',
  location: 'location',
  contact: 'contact',
};

/** One line of text for a message: a row's preview, a reply quote, a composer banner. */
export function previewText(item: TimelineItemView, t: Translate): string {
  const content = item.content;
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'media':
      return content.media.caption || t(`chat.attachment.${attachmentKind(content.media)}`);
    case 'poll':
      return content.poll.question;
    case 'location':
      return content.place.label ?? t('chat.attachment.location');
    case 'contact':
      return content.contact.name;
    case 'deleted':
      return t('message.deleted');
    case 'undecryptable':
      return t('message.undecryptable');
    case 'system':
      return content.text;
  }
}

function nameOf(accountId: string, ctx: ChatContext): string {
  if (accountId === ctx.me) return ctx.t('chat.you');
  return ctx.person(accountId)?.displayName ?? '';
}

function others(view: ConversationView, me: string | undefined): string[] {
  return view.memberAccountIds.filter((id) => id !== me);
}

// ---------------------------------------------------------------------------
// Conversations
// ---------------------------------------------------------------------------

const GROUP_TITLE_NAMES = 3;

/**
 * What a conversation is called. A DM is the other person; a group is its title
 * once somebody set one, and otherwise the first few members. `''` while nobody
 * in it can be named yet — never an account id.
 */
export function conversationTitle(view: ConversationView, ctx: ChatContext): string {
  const members = others(view, ctx.me);
  if (view.kind === 'dm') return members[0] ? nameOf(members[0], ctx) : '';
  if (view.title) return view.title;
  const named = members.map((id) => ctx.person(id)?.displayName).filter((name): name is string => Boolean(name));
  if (named.length === 0) return '';
  const shown = named.slice(0, GROUP_TITLE_NAMES);
  const rest = members.length - shown.length;
  return rest > 0 ? ctx.t('chat.group.titleMore', { names: shown.join(', '), count: rest }) : shown.join(', ');
}

/** A DM's avatar: the other person's Oxy file id or URL, which Bloom's image resolver loads. */
export function conversationAvatar(view: ConversationView, ctx: ChatContext): string | undefined {
  if (view.kind !== 'dm') return undefined;
  const other = others(view, ctx.me)[0];
  return other ? ctx.person(other)?.avatar : undefined;
}

/** A group's avatar: up to four of its other members. */
export function conversationFaces(view: ConversationView, ctx: ChatContext): ChatFace[] | undefined {
  if (view.kind !== 'group') return undefined;
  return others(view, ctx.me)
    .slice(0, 4)
    .map((id) => {
      const person = ctx.person(id);
      return { source: person?.avatar, name: person?.displayName };
    });
}

/**
 * The words for a conversation whose members have not all set up Allo, each
 * `null` when there is nothing to say:
 *
 * - `banner`, above the composer: what is going on, and that typing is fine —
 *   the SDK holds what is sent and delivers it when they join.
 * - `hold`, the accessible name of a held message's clock.
 * - `waiting`, a list row's line in place of the preview.
 *
 * A DM names the person; a group counts them, because a hold only happens when
 * EVERY other member is unreachable. While the name is still being looked up,
 * the line says "this person" — an account id never reaches the screen.
 */
export interface UnreachableCopy {
  banner: string | null;
  hold: string | null;
  waiting: string | null;
}

const NOBODY_UNREACHABLE: UnreachableCopy = { banner: null, hold: null, waiting: null };

export function unreachableCopy(view: ConversationView, ctx: ChatContext): UnreachableCopy {
  const ids = view.unreachableMemberAccountIds;
  if (ids.length === 0) return NOBODY_UNREACHABLE;
  const { t } = ctx;
  if (view.kind === 'group') {
    const count = ids.length;
    return {
      banner: t('chat.unreachable.group', { count }),
      hold: t('chat.hold.group', { count }),
      waiting: t('chat.waiting.group', { count }),
    };
  }
  const name = ctx.person(ids[0])?.displayName;
  if (!name) {
    return {
      banner: t('chat.unreachable.dmUnnamed'),
      hold: t('chat.hold.dmUnnamed'),
      waiting: t('chat.waiting.dmUnnamed'),
    };
  }
  return {
    banner: t('chat.unreachable.dm', { name }),
    hold: t('chat.hold.dm', { name }),
    waiting: t('chat.waiting.dm', { name }),
  };
}

function chatPreview(view: ConversationView, ctx: ChatContext): ChatPreview | undefined {
  const last = view.lastMessage;
  if (!last) return undefined;
  if (last.isOwn && last.holdReason) {
    const waiting = unreachableCopy(view, ctx).waiting;
    if (waiting) return { text: waiting };
  }
  const sender =
    last.content.kind === 'system'
      ? undefined
      : last.isOwn
        ? ctx.t('chat.you')
        : view.kind === 'group'
          ? ctx.person(last.senderAccountId)?.displayName
          : undefined;
  if (last.content.kind === 'media' && !last.content.media.caption) {
    const kind = attachmentKind(last.content.media);
    return { sender, attachment: { kind, label: ctx.t(`chat.attachment.${kind}`) } };
  }
  // A poll, a place and a card get the glyph AND their own words: the row has
  // room for one line, and "Poll" says less than the question does. An
  // attachment with no words of its own falls back to the generic name, which
  // is what `previewText` already answers.
  const attachment = ATTACHMENT_CONTENT[last.content.kind];
  if (attachment) {
    return { sender, attachment: { kind: attachment, label: previewText(last, ctx.t) } };
  }
  return { sender, text: previewText(last, ctx.t) };
}

/** `ConversationView` → one row of the conversation list. */
export function chatSummary(view: ConversationView, ctx: ChatContext): ChatSummary {
  const last = view.lastMessage;
  const other = view.kind === 'dm' ? others(view, ctx.me)[0] : undefined;
  return {
    id: view.id,
    kind: view.kind === 'group' ? 'group' : 'direct',
    verified: other ? ctx.person(other)?.verified : undefined,
    name: conversationTitle(view, ctx),
    avatar: conversationAvatar(view, ctx),
    faces: conversationFaces(view, ctx),
    preview: chatPreview(view, ctx),
    time: formatListTime(new Date(view.lastActivityAt), ctx.now, ctx.locale, ctx.t),
    unreadCount: view.unreadCount,
    outgoingStatus: last?.isOwn ? deliveryStatus(last.sendState) : undefined,
  };
}

/**
 * The messages somebody pinned for the whole conversation, oldest first — what
 * Bloom's `PinnedMessageBar` draws. A pin is an encrypted control message the
 * SDK folds onto its target, so this is only a reading of the timeline.
 */
export function pinnedMessages(items: readonly TimelineItemView[], ctx: ChatContext): ChatPinnedMessage[] {
  return items
    .filter((item) => item.pinned)
    .map((item) => ({
      id: item.id,
      preview: previewText(item, ctx.t),
      author: item.isOwn ? ctx.t('chat.you') : ctx.person(item.senderAccountId)?.displayName,
    }));
}

// ---------------------------------------------------------------------------
// Transcript
// ---------------------------------------------------------------------------

export interface TranscriptOptions {
  isGroup: boolean;
  /** The first message the viewer had not read when the conversation opened. */
  firstUnreadId?: string;
  /** The accessible name of a held message's clock; see {@link unreachableCopy}. */
  holdLabel?: string | null;
  /**
   * How wide a bubble may get. Bloom's 78% of the pane is right on a phone and
   * an unreadable line on a desktop-width conversation, so the screen passes a
   * measure in pixels once it has the room.
   */
  bubbleMaxWidth?: number;
}

function reactionsOf(item: TimelineItemView, me: string | undefined): MessageReaction[] | undefined {
  if (item.reactions.length === 0) return undefined;
  return item.reactions.map(({ key, accountIds }) => ({
    emoji: key,
    count: accountIds.length,
    mine: me !== undefined && accountIds.includes(me),
  }));
}

function replyPreview(
  item: TimelineItemView,
  byId: ReadonlyMap<string, TimelineItemView>,
  ctx: ChatContext,
): MessageReplyPreview | undefined {
  if (!item.replyTo) return undefined;
  const target = byId.get(item.replyTo);
  // The quoted message is older than the loaded window, or this device never had it.
  if (!target) return { senderName: '', preview: ctx.t('message.replyUnavailable') };
  return { senderName: nameOf(target.senderAccountId, ctx), preview: previewText(target, ctx.t) };
}

/**
 * `TimelineItemView[]` → the rows a transcript draws, oldest first as the SDK
 * gives them. Data only: gestures and media nodes are attached where the rows
 * are rendered, so this stays testable and the list can memoize on it.
 */
export function transcriptItems(
  items: readonly TimelineItemView[],
  ctx: ChatContext,
  options: TranscriptOptions,
): MessageListItem[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  return items.map((item) => {
    const sentAt = new Date(item.sentAt);
    const base: MessageListItem = {
      id: item.id,
      direction: item.isOwn ? 'outgoing' : 'incoming',
      senderId: item.senderAccountId,
      senderName: options.isGroup && !item.isOwn ? ctx.person(item.senderAccountId)?.displayName : undefined,
      avatarSource: options.isGroup && !item.isOwn ? ctx.person(item.senderAccountId)?.avatar : undefined,
      dateKey: dayKey(sentAt),
      dateLabel: formatDay(sentAt, ctx.now, ctx.locale, ctx.t),
      unreadBefore: item.id === options.firstUnreadId,
      maxWidth: options.bubbleMaxWidth,
      time: formatTime(sentAt, ctx.locale),
      status: item.isOwn ? deliveryStatus(item.sendState) : undefined,
      pending: item.sendState === 'pending',
      failed: item.sendState === 'failed',
      reactions: reactionsOf(item, ctx.me),
      replyTo: replyPreview(item, byId, ctx),
      labels: item.isOwn && item.holdReason && options.holdLabel ? { pending: options.holdLabel } : undefined,
    };
    const content = item.content;
    switch (content.kind) {
      case 'text':
        return { ...base, text: content.body, editedLabel: content.isEdited ? ctx.t('message.edited') : undefined };
      case 'media':
        return { ...base, text: content.media.caption || undefined };
      // A poll, a place and a card are drawn by the media slot the screen
      // fills, so the bubble itself carries no text of its own.
      case 'poll':
      case 'location':
      case 'contact':
        return base;
      case 'deleted':
        return { ...base, deleted: true, reactions: undefined };
      case 'undecryptable':
        return { ...base, text: ctx.t('message.undecryptable') };
      case 'system':
        return { ...base, system: content.text };
    }
  });
}

/**
 * The first incoming message after the viewer's last read, as of when the
 * conversation opened: where the "unread messages" separator goes. The SDK
 * reports only a count, so it is the `unreadCount`-th incoming message from
 * the end.
 */
export function firstUnreadId(items: readonly TimelineItemView[], unreadCount: number): string | undefined {
  if (unreadCount <= 0) return undefined;
  let seen = 0;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (items[index].isOwn) continue;
    seen += 1;
    if (seen === unreadCount) return items[index].id;
  }
  return undefined;
}
