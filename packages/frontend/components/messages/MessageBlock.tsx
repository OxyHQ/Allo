import React, { memo, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MessageBubble } from './MessageBubble';
import { MediaCarousel } from './MediaCarousel';
import { MessageMetadata } from './MessageMetadata';
import { MessageAvatar } from './MessageAvatar';
import type { MediaItem } from '@/stores';
import { MessageGroup } from '@/utils/messageGrouping';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import { colors } from '@/styles/colors';

export interface MessageBlockProps {
  group: MessageGroup;
  isGroup?: boolean;
  getSenderName?: (senderId: string) => string | undefined;
  getSenderAvatar?: (senderId: string) => string | undefined;
  getMediaUrl: (mediaId: string) => string;
  visibleTimestampId?: string | null;
  onMessagePress: (messageId: string) => void;
  onMediaPress?: (mediaId: string, index: number) => void;
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
  onMediaPress,
}) => {
  const theme = useTheme();
  
  const { messages, isAiGroup, senderId, isSent } = group;
  const firstMessage = messages[0];
  const lastMessage = messages[messages.length - 1];
  
  const isIncoming = !isSent;
  const senderName = isIncoming && senderId ? getSenderName?.(senderId) : undefined;
  const senderAvatar = isIncoming && senderId ? getSenderAvatar?.(senderId) : undefined;
  const showSenderName = Boolean(isGroup && !isAiGroup && isIncoming && senderName);
  
  // Check if timestamp should be shown (on last message in group)
  const showTimestamp = Boolean(
    visibleTimestampId && visibleTimestampId === lastMessage.id
  );

  // Collect all media items from all messages in the group
  const allMedia: MediaItem[] = useMemo(() => {
    return messages.flatMap(msg => msg.media || []);
  }, [messages]);

  // Check if there's text content
  const hasText = messages.some(msg => msg.text && msg.text.trim().length > 0);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'flex-end',
      paddingHorizontal: 8,
      paddingVertical: 2,
      marginVertical: 2,
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
      width: 40,
      marginRight: 6,
      alignItems: 'center',
      justifyContent: 'flex-end',
    },
    avatarSpacer: {
      width: 40,
      height: 40,
    },
    content: {
      flexShrink: 1,
      maxWidth: isAiGroup ? '100%' : '78%',
      rowGap: 4,
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
      marginBottom: 4,
      marginLeft: 12,
    },
    bubblesContainer: {
      gap: 2,
    },
  }), [isAiGroup, theme]);

  const handleMessagePress = useCallback((messageId: string) => {
    onMessagePress(messageId);
  }, [onMessagePress]);

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
      {/* Avatar slot for incoming messages */}
      {!isAiGroup && isIncoming && (
        <View style={styles.avatarSlot}>
          {senderAvatar ? (
            <MessageAvatar
              name={senderName}
              avatarUri={senderAvatar}
              size={40}
            />
          ) : (
            <View style={styles.avatarSpacer} />
          )}
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
          />
        )}

        {/* Message bubbles */}
        {hasText && (
          <View style={styles.bubblesContainer}>
            {messages.map((message, index) => {
              const isFirst = index === 0;
              const isLast = index === messages.length - 1;
              const prevMessage = index > 0 ? messages[index - 1] : null;
              const isCloseToPrevious = prevMessage !== null;
              
              return (
                <MessageBubble
                  key={message.id}
                  id={message.id}
                  text={message.text}
                  timestamp={message.timestamp}
                  isSent={message.isSent}
                  senderName={undefined} // Sender name shown at block level
                  showSenderName={false}
                  showTimestamp={false} // Timestamp shown at block level
                  isCloseToPrevious={isCloseToPrevious}
                  messageType={message.messageType || 'user'}
                  media={[]} // Media is handled at block level
                  getMediaUrl={getMediaUrl}
                  onPress={() => handleMessagePress(message.id)}
                />
              );
            })}
          </View>
        )}

        {/* Message metadata (time, edited, read) - shown on last message */}
        <MessageMetadata
          timestamp={lastMessage.timestamp}
          isSent={isSent}
          isEdited={false} // TODO: Add edited status to Message type
          readStatus={isSent ? 'read' : undefined} // TODO: Add read status to Message type
          showTimestamp={showTimestamp}
        />
      </View>

      {/* Spacer for sent messages */}
      {!isAiGroup && !isIncoming && (
        <View style={styles.avatarSlot} />
      )}
    </View>
  );
});

MessageBlock.displayName = 'MessageBlock';

