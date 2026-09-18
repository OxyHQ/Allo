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
import type { ConversationView, MediaView, SendState, TimelineItemView } from '@allo/core';
import type { MessageDeliveryStatus } from '@oxy.so/bloom/chat-indicators';
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

/** One line of text for a message: a row's preview, a reply quote, a composer banner. */
export function previewText(item: TimelineItemView, t: Translate): string {
  const content = item.content;
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'media':
      return content.media.caption || t(`chat.attachment.${attachmentKind(content.media)}`);
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

/**
 * The line in place of the composer while this device cannot read or send
 * here yet, or `null` once it can. `busy` says a spinner belongs next to it:
 *
 * - `joining`: the device is joining by itself from the stored GroupInfo
 *   (`crypto.md` section 5); nobody else is needed and it is over in a sync.
 * - `waiting_for_member`: the server holds no GroupInfo for the current epoch
 *   (a conversation whose last commit predates the field), so a member's
 *   device has to add this one — and it can only do that while it is online.
 *   Also what a removed or left member reads.
 */
export interface JoinNotice {
  text: string;
  busy: boolean;
}

export function joinNotice(view: ConversationView, t: Translate): JoinNotice | null {
  switch (view.joinState) {
    case 'joined':
      return null;
    case 'joining':
      return { text: t('chat.joining'), busy: true };
    case 'waiting_for_member':
      return { text: `${t('chat.notJoined')} ${t('chat.notJoinedHint')}`, busy: false };
  }
}

/**
 * What takes the composer's place, or `null` when the person can type. The
 * integrity failure comes first and stays: this device refused a commit the
 * server accepted (a joiner it could not verify), so the group moved on
 * without it and nothing sent from here reaches anybody. The SDK never clears
 * it and the app offers no way out — fail closed (`crypto.md` section 5).
 * `error` says it is drawn as a failure, not as a wait.
 */
export interface ComposerNotice extends JoinNotice {
  error: boolean;
}

export function composerNotice(view: ConversationView, t: Translate): ComposerNotice | null {
  if (view.integrity === 'refused_commit') return { text: t('chat.integrity.refused'), busy: false, error: true };
  const join = joinNotice(view, t);
  return join ? { ...join, error: false } : null;
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
  return { sender, text: previewText(last, ctx.t) };
}

/** `ConversationView` → one row of the conversation list. */
export function chatSummary(view: ConversationView, ctx: ChatContext): ChatSummary {
  const last = view.lastMessage;
  return {
    id: view.id,
    kind: view.kind === 'group' ? 'group' : 'direct',
    name: conversationTitle(view, ctx),
    avatar: conversationAvatar(view, ctx),
    faces: conversationFaces(view, ctx),
    preview: chatPreview(view, ctx),
    time: formatListTime(new Date(view.lastActivityAt), ctx.now, ctx.locale, ctx.t),
    unreadCount: view.unreadCount,
    outgoingStatus: last?.isOwn ? deliveryStatus(last.sendState) : undefined,
  };
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
  /**
   * The same for an echo held as `epoch_stalled`: the outbox stopped sending
   * because this device's epoch cannot catch up with the server's (see
   * {@link composerNotice}); the SDK releases it on its own if it ever does.
   */
  stalledLabel?: string | null;
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
    const holdLabel = !item.isOwn || !item.holdReason ? undefined : item.holdReason === 'epoch_stalled' ? options.stalledLabel : options.holdLabel;
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
      labels: holdLabel ? { pending: holdLabel } : undefined,
    };
    const content = item.content;
    switch (content.kind) {
      case 'text':
        return { ...base, text: content.body, editedLabel: content.isEdited ? ctx.t('message.edited') : undefined };
      case 'media':
        return { ...base, text: content.media.caption || undefined };
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
