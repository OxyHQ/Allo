import React, { memo, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import * as Clipboard from 'expo-clipboard';
import type { TimelineItemView } from '@allo/core';
import { MessageContextMenu, type MessageMenuItem } from '@oxy.so/bloom/chat-composer';
import { RiDeleteBinLine, RiFileCopyLine, RiPencilLine, RiArrowGoBackLine } from '@oxy.so/bloom/icons';
import {
  MessageBubble,
  type MessageBubbleLabels,
  type MessageListItem,
  type MessagePosition,
} from '@oxy.so/bloom/message-bubble';
import { toast } from '@oxy.so/bloom/toast';

import { MessageMedia } from '@/components/chat/media/MessageMedia';

/** What the conversation screen does when a message is acted on. */
export interface MessageActions {
  reply: (id: string) => void;
  edit: (id: string) => void;
  remove: (id: string) => void;
  react: (id: string, emoji: string) => void;
  openMedia: (id: string) => void;
}

interface MessageRowProps {
  item: MessageListItem;
  source: TimelineItemView;
  /** Set by the enclosing `MessageGroup`, which decides the run's corners. */
  position?: MessagePosition;
  labels: Partial<MessageBubbleLabels>;
  actions: MessageActions;
}

/** One bubble, with its media and the menu a press opens. */
export const MessageRow = memo(function MessageRow({ item, source, position, labels, actions }: MessageRowProps) {
  const { t } = useTranslation();
  const {
    id,
    senderId: _senderId,
    dateKey: _dateKey,
    dateLabel: _dateLabel,
    unreadBefore: _unreadBefore,
    system: _system,
    call: _call,
    avatarSource: _avatarSource,
    onPressAvatar: _onPressAvatar,
    senderName: _senderName,
    labels: ownLabels,
    ...bubble
  } = item;
  const content = source.content;
  const settled = source.sendState !== 'pending' && source.sendState !== 'failed';

  const menu = useMemo<MessageMenuItem[]>(() => {
    const entries: MessageMenuItem[] = [];
    if (settled) entries.push({ id: 'reply', label: t('message.reply'), icon: RiArrowGoBackLine });
    if (content.kind === 'text') entries.push({ id: 'copy', label: t('message.copy'), icon: RiFileCopyLine });
    if (source.isOwn && settled && content.kind === 'text') {
      entries.push({ id: 'edit', label: t('message.edit'), icon: RiPencilLine });
    }
    if (source.isOwn && settled) {
      entries.push({ id: 'delete', label: t('message.delete'), icon: RiDeleteBinLine, variant: 'destructive', separated: true });
    }
    return entries;
  }, [content.kind, settled, source.isOwn, t]);

  const mine = bubble.reactions?.find((reaction) => reaction.mine)?.emoji;

  const media =
    content.kind === 'media' ? (
      <MessageMedia media={content.media} tone={bubble.direction} onOpen={() => actions.openMedia(id)} />
    ) : undefined;

  const bubbleNode = (
    <MessageBubble
      {...bubble}
      position={position}
      media={media}
      labels={ownLabels ? { ...labels, ...ownLabels } : labels}
      onToggleReaction={settled ? (emoji) => actions.react(id, emoji) : undefined}
      onSwipeReply={settled ? () => actions.reply(id) : undefined}
    />
  );

  if (content.kind === 'deleted' || content.kind === 'undecryptable' || menu.length === 0) return bubbleNode;

  return (
    <MessageContextMenu
      label={t('message.actions')}
      items={menu}
      reactions={settled ? undefined : false}
      selectedReaction={mine}
      onSelectReaction={(emoji) => actions.react(id, emoji)}
      onSelect={(action) => {
        if (action === 'reply') actions.reply(id);
        else if (action === 'edit') actions.edit(id);
        else if (action === 'delete') actions.remove(id);
        else if (action === 'copy' && content.kind === 'text') {
          void Clipboard.setStringAsync(content.body).then(() => toast.success(t('message.copied')));
        }
      }}
    >
      {bubbleNode}
    </MessageContextMenu>
  );
});
