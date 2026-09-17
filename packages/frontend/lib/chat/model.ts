/**
 * WHAT A SCREEN DRAWS, and how it is made from what the SDK reports.
 *
 * `@allo/react` answers with `ConversationView` and `TimelineItemView`; the
 * screens and message components were written against `Conversation` and
 * `Message`. The two shapes are close but not the same — a bubble wants a
 * `Date`, a `readStatus` and a flat `text`, the SDK gives an ISO string, a
 * `sendState` and a tagged `content` — and rather than rewrite forty components
 * to the SDK's vocabulary, this module projects one into the other, in pure
 * functions that a test can hold still.
 *
 * Nothing here talks to a network, a store or React. Names and avatars are
 * NOT here either: a `ConversationParticipant` carries an Oxy account id and
 * the people layer (`lib/allo/people.ts`, `usersStore`) fills in the rest.
 */
import type { ConversationView, MediaRef, MediaView, SendState, TimelineItemView } from '@allo/core';

export type ConversationType = 'direct' | 'group';

export interface ConversationParticipant {
  /** An Oxy account id. */
  id: string;
  name?: {
    /** Canonical, ready-to-render display string from the Oxy API. */
    displayName: string;
    first: string;
    last: string;
  };
  username?: string;
  avatar?: string;
}

export interface Conversation {
  id: string;
  type: ConversationType;
  /** For a group: its title, or `''` until one is set. For a DM: `''` — the people layer names it. */
  name: string;
  /** A one-line preview of the last message, already decrypted on this device. */
  lastMessage: string;
  timestamp: string;
  unreadCount: number;
  avatar?: string;
  /** Every member, the viewer included. Ids only; see `ConversationParticipant`. */
  participants: ConversationParticipant[];
  groupName?: string;
  groupAvatar?: string;
  participantCount?: number;
  /** Whether this device can read and send: false while a second device is still being added to the group. */
  joined: boolean;
  /** What the viewer may do to the group: only an owner or admin adds and removes members. */
  myRole: 'owner' | 'admin' | 'member';
}

export interface MediaItem {
  /** The blob id of the full-size file. Unique within a conversation. */
  id: string;
  type: 'image' | 'video' | 'gif';
  /** The full-size original. */
  ref: MediaRef;
  /**
   * A smaller copy the sender made, when there is one. A bubble draws it; the
   * viewer shows it underneath while the original downloads.
   */
  thumbnailRef?: MediaRef;
  mime: string;
  /** What the sender called it. Used to name a share, never drawn in a bubble. */
  filename?: string;
  width?: number;
  height?: number;
}

/**
 * What an attachment is when no bubble can draw it.
 *
 * A picture and a video go through {@link MediaItem}, because the carousel
 * renders them and the bubble *is* the picture. The other three have no picture:
 * a voice note is a player, an audio file is a player, a document is a row with
 * a name and a size.
 */
export type MessageAttachmentKind = 'audio' | 'voice' | 'file';

export interface MessageAttachment {
  kind: MessageAttachmentKind;
  /** Where the bytes are. Downloaded and decrypted on demand by `useMediaUri`. */
  ref: MediaRef;
  mime: string;
  /** The sender's filename. Never empty. */
  filename: string;
  /** Bytes, as the sender's client reported them. Not verified. */
  size?: number;
  /** Milliseconds, for audio and voice notes. */
  durationMs?: number;
}

export interface StickerItem {
  id: string;
  /** URL string, local require() asset (number for images, object for JSON), or Lottie JSON object */
  source: string | number | object;
  /** Optional emoji fallback if Lottie fails to load */
  emoji?: string;
  /** Sticker pack identifier */
  packId?: string;
}

/**
 * How far a message the viewer sent got on its way out.
 *
 * `failed` is not a slower `pending`. Pending means something is still trying;
 * failed means nothing is, and the two draw different marks — see
 * `components/messages/messageStatus.ts`.
 */
export type MessageReadStatus = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface Message {
  id: string;
  text: string;
  /** An Oxy account id. */
  senderId: string;
  senderName?: string;
  timestamp: Date;
  isSent: boolean;
  conversationId: string;
  messageType?: 'user' | 'ai';
  media?: MediaItem[];
  /** An attachment the carousel cannot draw. See {@link MessageAttachment}. */
  attachment?: MessageAttachment;
  sticker?: StickerItem;
  fontSize?: number;
  replyTo?: string;
  reactions?: Record<string, string[]>;
  /** Drawn on the sender's own bubble only. See {@link MessageReadStatus}. */
  readStatus?: MessageReadStatus;
  /** The body has been replaced since it was sent. */
  isEdited?: boolean;
  /** The sender took it back; the body is a placeholder. */
  isDeleted?: boolean;
  /** This device could not decrypt it; the body says why. */
  isUndecryptable?: boolean;
}

// ---------------------------------------------------------------------------
// Projections
// ---------------------------------------------------------------------------

const READ_STATUS: Record<SendState, MessageReadStatus> = {
  pending: 'pending',
  accepted: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

/** The text a bubble shows for content that has no body of its own. */
export const PLACEHOLDER_TEXT = {
  deleted: 'This message was deleted',
  undecryptable: 'This message could not be decrypted on this device',
} as const;

/** `TimelineItemView` → `Message`. Pure. */
export function messageFromItem(item: TimelineItemView): Message {
  const base: Message = {
    id: item.id,
    text: '',
    senderId: item.senderAccountId,
    timestamp: new Date(item.sentAt),
    isSent: item.isOwn,
    conversationId: item.conversationId,
    messageType: 'user',
    replyTo: item.replyTo,
    reactions: reactionsFromItem(item),
    readStatus: item.isOwn ? READ_STATUS[item.sendState] : undefined,
  };
  const content = item.content;
  switch (content.kind) {
    case 'text':
      return { ...base, text: content.body, isEdited: content.isEdited };
    case 'media':
      return { ...base, text: content.media.caption ?? '', ...attachmentFields(content.media) };
    case 'deleted':
      return { ...base, text: PLACEHOLDER_TEXT.deleted, isDeleted: true };
    case 'undecryptable':
      return { ...base, text: PLACEHOLDER_TEXT.undecryptable, isUndecryptable: true };
    case 'system':
      // A system line is drawn the way an "ai" message is: plain text, no
      // bubble, the full width. That is the one bubble-less style the
      // components have.
      return { ...base, text: content.text, messageType: 'ai' };
  }
}

function reactionsFromItem(item: TimelineItemView): Record<string, string[]> | undefined {
  if (item.reactions.length === 0) return undefined;
  const out: Record<string, string[]> = {};
  for (const reaction of item.reactions) out[reaction.key] = [...reaction.accountIds];
  return out;
}

function attachmentFields(media: MediaView): Pick<Message, 'media' | 'attachment'> {
  if (media.kind === 'image' || media.kind === 'video') {
    return {
      media: [
        {
          id: media.ref.blobId,
          type: media.kind === 'image' && media.mime === 'image/gif' ? 'gif' : media.kind,
          ref: media.ref,
          thumbnailRef: media.thumbnail?.ref,
          mime: media.mime,
          filename: media.filename,
          width: media.width,
          height: media.height,
        },
      ],
    };
  }
  return {
    attachment: {
      kind: media.kind,
      ref: media.ref,
      mime: media.mime,
      filename: media.filename,
      size: media.size,
      durationMs: media.durationMs,
    },
  };
}

/** `TimelineItemView[]` → `Message[]`, oldest first as the SDK gives them. */
export function messagesFromItems(items: readonly TimelineItemView[]): Message[] {
  return items.map(messageFromItem);
}

/** The one-line preview a list row shows for a message. */
export function previewOf(item: TimelineItemView | undefined): string {
  if (!item) return '';
  const content = item.content;
  switch (content.kind) {
    case 'text':
      return content.body;
    case 'media':
      return content.media.caption ?? MEDIA_PREVIEW[content.media.kind];
    case 'deleted':
      return PLACEHOLDER_TEXT.deleted;
    case 'undecryptable':
      return PLACEHOLDER_TEXT.undecryptable;
    case 'system':
      return content.text;
  }
}

const MEDIA_PREVIEW: Record<MediaView['kind'], string> = {
  image: 'Photo',
  video: 'Video',
  audio: 'Audio',
  voice: 'Voice message',
  file: 'File',
};

/** `ConversationView` → `Conversation`. Pure; the people layer names the participants later. */
export function conversationFromView(view: ConversationView): Conversation {
  const isGroup = view.kind === 'group';
  return {
    id: view.id,
    type: isGroup ? 'group' : 'direct',
    name: view.title ?? '',
    lastMessage: previewOf(view.lastMessage),
    timestamp: view.lastActivityAt,
    unreadCount: view.unreadCount,
    participants: view.memberAccountIds.map((id) => ({ id })),
    groupName: isGroup ? (view.title ?? undefined) : undefined,
    participantCount: isGroup ? view.memberAccountIds.length : undefined,
    joined: view.joined,
    myRole: view.myRole,
  };
}
