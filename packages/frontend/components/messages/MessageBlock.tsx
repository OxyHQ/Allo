import React, { memo, useMemo, useCallback, useRef, useState, useEffect } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, GestureResponderEvent } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MessageBubble } from './MessageBubble';
import { StickerBubble } from './StickerBubble';
import { MediaCarousel } from './MediaCarousel';
import { MessageAvatar } from './MessageAvatar';
import type { MediaItem, Message } from '@/stores';
import { MessageGroup } from '@/utils/messageGrouping';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import { colors } from '@/styles/colors';
import { useAvatarShape } from '@/hooks/useAvatarShape';

export interface MessageBlockProps {
  group: MessageGroup;
  isGroup?: boolean;
  getSenderName?: (senderId: string) => string | undefined;
  getSenderAvatar?: (senderId: string) => string | undefined;
  getMediaUrl: (mediaId: string) => string;
  visibleTimestampId?: string | null;
  onMessagePress: (messageId: string) => void;
  onMessageLongPress?: (message: Message, position: { x: number; y: number; width?: number; height?: number }) => void;
  onMediaPress?: (mediaId: string, index: number) => void;
  onMediaLongPress?: (message: Message, mediaId: string, index: number, event: any) => void;
}

/**
 * MessageBlock Component
 * 
 * Displays a group of messages from the same time period.
 * Similar to WhatsApp's message grouping.
 * Contains:
 * - Multiple message bubbles (if messages are from same time)
 * - Media carousel (images, videos, polls, cards, etc.)
 * - Message metadata (time, edited, read status)
 * - Sender avatar and name (for incoming messages)
 * 
 * AI messages span full width (left 0 to right 0) and are left-aligned.
 * Regular messages are aligned left (incoming) or right (sent).
 * 
 * @example
 * ```tsx
 * <MessageBlock
 *   group={messageGroup}
 *   isGroup={true}
 *   getSenderName={(id) => 'John'}
 *   getMediaUrl={(id) => `https://example.com/${id}`}
 *   onMessagePress={(id) => console.log('Pressed', id)}
 * />
 * ```
 */
export const MessageBlock = memo<MessageBlockProps>(({
  group,
  isGroup = false,
  getSenderName,
  getSenderAvatar,
  getMediaUrl,
  visibleTimestampId,
  onMessagePress,
  onMessageLongPress,
  onMediaPress,
  onMediaLongPress,
}) => {
  const theme = useTheme();

  const { messages, isAiGroup, senderId, isSent } = group;
  const isIncoming = !isSent;
  const senderName = isIncoming && senderId ? getSenderName?.(senderId) : undefined;
  const senderAvatar = isIncoming && senderId ? getSenderAvatar?.(senderId) : undefined;
  const senderShape = useAvatarShape(isIncoming ? senderId : undefined);
  const showSenderName = Boolean(isGroup && !isAiGroup && isIncoming && senderName);

  // Create refs map for each message bubble using useState
  const [bubbleRefsMap] = useState(() => {
    const map = new Map<string, React.RefObject<View>>();
    messages.forEach(msg => {
      map.set(msg.id, React.createRef<View>());
    });
    return map;
  });

  // Update refs map when messages change
  useEffect(() => {
    messages.forEach(msg => {
      if (!bubbleRefsMap.has(msg.id)) {
        bubbleRefsMap.set(msg.id, React.createRef<View>());
      }
    });
    // Clean up refs for removed messages
    const messageIds = new Set(messages.map(m => m.id));
    for (const [id] of bubbleRefsMap) {
      if (!messageIds.has(id)) {
        bubbleRefsMap.delete(id);
      }
    }
  }, [messages, bubbleRefsMap]);

  // Collect all media items from all messages in the group
  const allMedia: MediaItem[] = useMemo(() => {
    return messages.flatMap(msg => msg.media || []);
  }, [messages]);

  // Check if there's text content
  const hasText = messages.some(msg => msg.text && msg.text.trim().length > 0);

  // Check if any message in the group is a sticker
  const hasSticker = messages.some(msg => msg.sticker);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: MESSAGING_CONSTANTS.BLOCK_PADDING_HORIZONTAL,
      paddingVertical: MESSAGING_CONSTANTS.BLOCK_PADDING_VERTICAL,
      marginVertical: MESSAGING_CONSTANTS.BLOCK_MARGIN_VERTICAL,
    },
    containerAi: {
      paddingLeft: 0,
      paddingRight: 0,
      alignSelf: 'stretch',
      width: '100%',
      marginHorizontal: 0,
    },
    containerIncoming: {
      justifyContent: 'flex-start',
    },
    containerSent: {
      justifyContent: 'flex-end',
    },
    avatarSlot: {
      width: 36,
      marginRight: 6,
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    avatarSpacer: {
      width: 36,
      height: 36,
    },
    content: {
      flexShrink: 1,
      maxWidth: isAiGroup ? '100%' : MESSAGING_CONSTANTS.MAX_MESSAGE_WIDTH,
      rowGap: MESSAGING_CONSTANTS.BLOCK_CONTENT_ROW_GAP,
    },
    contentAi: {
      maxWidth: '100%',
      alignSelf: 'stretch',
      paddingHorizontal: 16,
    },
    contentIncoming: {
      alignSelf: 'flex-start',
    },
    contentSent: {
      alignSelf: 'flex-end',
      alignItems: 'flex-end',
    },
    senderName: {
      fontSize: MESSAGING_CONSTANTS.SENDER_NAME_SIZE,
      fontWeight: '600',
      color: theme.colors.textSecondary || '#666666',
      marginBottom: 2,
      marginLeft: 10,
    },
    bubblesContainer: {
      gap: MESSAGING_CONSTANTS.BLOCK_BUBBLES_GAP,
    },
  }), [isAiGroup, theme]);

  const handleMessagePress = useCallback((messageId: string) => {
    onMessagePress(messageId);
  }, [onMessagePress]);

  // Create a single callback factory for long press that doesn't use hooks
  const createBubbleLongPressHandler = useCallback((message: Message) => {
    return (event: GestureResponderEvent) => {
      if (onMessageLongPress) {
        const bubbleRef = bubbleRefsMap.get(message.id);
        if (bubbleRef?.current) {
          bubbleRef.current.measureInWindow((pageX, pageY, width, height) => {
            onMessageLongPress(message, {
              x: pageX,
              y: pageY,
              width: width || 0,
              height: height || 0,
            });
          });
        } else {
          // Fallback to event position if ref not available
          const { pageX, pageY } = event.nativeEvent;
          onMessageLongPress(message, {
            x: pageX,
            y: pageY,
            width: 0,
            height: 0,
          });
        }
      }
    };
  }, [onMessageLongPress, bubbleRefsMap]);

  const containerStyle = useMemo(() => [
    styles.container,
    isAiGroup && styles.containerAi,
    !isAiGroup && (isIncoming ? styles.containerIncoming : styles.containerSent),
  ], [styles, isAiGroup, isIncoming]);

  const contentStyle = useMemo(() => [
    styles.content,
    isAiGroup && styles.contentAi,
    !isAiGroup && (isIncoming ? styles.contentIncoming : styles.contentSent),
  ], [styles, isAiGroup, isIncoming]);

  return (
    <View style={containerStyle}>
      {/* Avatar slot for incoming messages (only in group conversations) */}
      {!isAiGroup && isIncoming && isGroup && (
        <View style={styles.avatarSlot}>
          <MessageAvatar
            name={senderName}
            avatarUri={senderAvatar}
            size={36}
            shape={senderShape}
          />
        </View>
      )}

      {/* Message content */}
      <View style={contentStyle}>
        {/* Sender name (for group conversations) */}
        {showSenderName && senderName && (
          <Text style={styles.senderName}>{senderName}</Text>
        )}

        {/* Media carousel (all media from all messages in group) */}
        {allMedia.length > 0 && (
          <MediaCarousel
            media={allMedia}
            isAiMessage={isAiGroup}
            getMediaUrl={getMediaUrl}
            onMediaPress={onMediaPress}
            onMediaLongPress={(mediaId, index, event) => {
              // Find the message that contains this media item
              const messageWithMedia = messages.find(msg =>
                msg.media?.some(m => m.id === mediaId)
              );
              if (messageWithMedia && onMediaLongPress) {
                // Measure the media container position properly
                const target = event.currentTarget;
                if (target && 'measure' in target && typeof target.measure === 'function') {
                  // @ts-ignore - measure exists on View but TypeScript doesn't know
                  target.measure((x, y, width, height, pageX, pageY) => {
                    onMediaLongPress(messageWithMedia, mediaId, index, {
                      x: pageX || event.nativeEvent.pageX,
                      y: pageY || event.nativeEvent.pageY,
                      width: width || 200,
                      height: height || 150,
                    });
                  });
                } else {
                  // Fallback to event position
                  const { pageX, pageY } = event.nativeEvent;
                  onMediaLongPress(messageWithMedia, mediaId, index, {
                    x: pageX,
                    y: pageY,
                    width: 200,
                    height: 150,
                  });
                }
              }
            }}
          />
        )}

        {/* Stickers (Lottie animations — no bubble, standalone) */}
        {hasSticker && messages.map((message) =>
          message.sticker ? (
            <StickerBubble
              key={`sticker-${message.id}`}
              sticker={message.sticker}
              isSent={message.isSent}
              timestamp={message.timestamp}
            />
          ) : null
        )}

        {/* Message bubbles */}
        {hasText && (
          <View style={styles.bubblesContainer}>
            {messages.map((message, index) => {
              // Skip sticker-only messages (no text)
              if (message.sticker && (!message.text || !message.text.trim())) return null;

              const prevMessage = index > 0 ? messages[index - 1] : null;
              const isCloseToPrevious = prevMessage !== null;
              const showTimestamp = message.messageType !== 'ai';

              const bubbleRef = bubbleRefsMap.get(message.id);
              const handleBubbleLongPress = createBubbleLongPressHandler(message);

              return (
                <TouchableOpacity
                  key={message.id}
                  activeOpacity={0.9}
                  onLongPress={handleBubbleLongPress}
                  delayLongPress={400}
                >
                  <View ref={bubbleRef}>
                    <MessageBubble
                      id={message.id}
                      text={message.text}
                      timestamp={message.timestamp}
                      isSent={message.isSent}
                      senderName={undefined} // Sender name shown at block level
                      showSenderName={false}
                      showTimestamp={showTimestamp}
                      isCloseToPrevious={isCloseToPrevious}
                      messageType={message.messageType || 'user'}
                      readStatus={message.readStatus}
                      isEdited={false} // TODO: Add edited status to Message type
                      fontSize={message.fontSize} // Use custom font size if set
                    />
                  </View>
                </TouchableOpacity>
              );
            })}
          </View>
        )}
      </View>

    </View>
  );
});

MessageBlock.displayName = 'MessageBlock';
