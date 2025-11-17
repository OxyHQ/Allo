import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image } from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import type { MediaItem } from '@/stores';

export interface MessageBubbleProps {
  id: string;
  text: string;
  timestamp: Date;
  isSent: boolean;
  senderName?: string;
  showSenderName: boolean;
  showTimestamp: boolean;
  isCloseToPrevious?: boolean;
  messageType?: 'user' | 'ai'; // Type of message: user (with bubble) or ai (plain text, no bubble)
  media?: MediaItem[]; // Array of media attachments
  getMediaUrl?: (mediaId: string) => string; // Function to get media URL from ID
  onPress: () => void;
}

/**
 * MessageBubble Component
 * 
 * Displays a single message bubble with optional sender name and timestamp.
 * Optimized with React.memo for performance.
 * 
 * @example
 * ```tsx
 * <MessageBubble
 *   id="msg-1"
 *   text="Hello!"
 *   timestamp={new Date()}
 *   isSent={true}
 *   showTimestamp={true}
 *   onPress={() => {}}
 * />
 * ```
 */
export const MessageBubble = memo<MessageBubbleProps>(({
  id,
  text,
  timestamp,
  isSent,
  senderName,
  showSenderName,
  showTimestamp,
  isCloseToPrevious = false,
  messageType = 'user',
  media = [],
  getMediaUrl,
  onPress,
}) => {
  const theme = useTheme();
  
  const timeString = useMemo(
    () => timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS),
    [timestamp]
  );
  
  const isAiMessage = messageType === 'ai';
  
  const styles = useMemo(() => {
    const marginTop = showSenderName
      ? MESSAGING_CONSTANTS.MESSAGE_SPACING_WITH_SENDER
      : isCloseToPrevious
      ? MESSAGING_CONSTANTS.MESSAGE_MARGIN_CLOSE
      : MESSAGING_CONSTANTS.MESSAGE_MARGIN_VERTICAL;

    return StyleSheet.create({
      container: {
        flexDirection: 'column',
        marginTop,
        marginBottom: MESSAGING_CONSTANTS.MESSAGE_MARGIN_VERTICAL,
        maxWidth: MESSAGING_CONSTANTS.MAX_MESSAGE_WIDTH,
        alignSelf: 'flex-start',
      },
      containerSent: {
        alignSelf: 'flex-end',
        alignItems: 'flex-end',
      },
      containerWithSender: {
        marginTop: MESSAGING_CONSTANTS.MESSAGE_SPACING_WITH_SENDER,
      },
      senderName: {
        fontSize: MESSAGING_CONSTANTS.SENDER_NAME_SIZE,
        fontWeight: '600',
        color: theme.colors.textSecondary,
        marginBottom: 2,
        marginLeft: 12,
      },
      bubble: {
        paddingHorizontal: MESSAGING_CONSTANTS.MESSAGE_PADDING_HORIZONTAL,
        paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
        borderRadius: MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
        backgroundColor: colors.messageBubbleReceived,
      },
      bubbleSent: {
        backgroundColor: colors.messageBubbleSent,
      },
      bubbleAi: {
        // No bubble styling for AI messages, but same vertical padding as bubbles
        paddingHorizontal: 0,
        paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
        borderRadius: 0,
        backgroundColor: 'transparent',
      },
      text: {
        fontSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE,
        lineHeight: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE * 1.4, // 1.4x for better readability
        color: colors.messageTextReceived,
      },
      textSent: {
        color: colors.messageTextSent,
      },
      textAi: {
        // Plain text styling for AI messages
        lineHeight: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE * 1.4, // 1.4x for better readability
        color: theme.colors.text || colors.messageTextReceived,
      },
      mediaContainer: {
        marginBottom: 4,
        borderRadius: MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
        overflow: 'hidden',
        backgroundColor: 'transparent',
      },
      mediaContainerAi: {
        marginBottom: 4,
        borderRadius: 12,
        overflow: 'hidden',
        backgroundColor: 'transparent',
      },
      mediaImage: {
        width: '100%',
        maxWidth: 250,
        height: 200,
        resizeMode: 'cover',
        borderRadius: MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
      },
      mediaImageAi: {
        width: '100%',
        maxWidth: 250,
        height: 200,
        resizeMode: 'cover',
        borderRadius: 12,
      },
      timestamp: {
        fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
        color: colors.messageTimestamp,
        marginTop: 4,
      },
      timestampAi: {
        // Negative margin to compensate for bubble padding and match visual spacing
        marginTop: -MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
      },
      timestampSent: {
        alignSelf: 'flex-end',
      },
      timestampReceived: {
        alignSelf: 'flex-start',
      },
    });
  }, [theme.colors.textSecondary, theme.colors.text]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      style={[
        styles.container,
        !isAiMessage && isSent && styles.containerSent,
        showSenderName && styles.containerWithSender,
      ]}
      testID={`message-${id}`}
    >
      {showSenderName && senderName && (
        <ThemedText style={styles.senderName}>{senderName}</ThemedText>
      )}
      {/* Media - rendered outside bubble, like Messenger */}
      {media && media.length > 0 && getMediaUrl && (
        <View style={isAiMessage ? styles.mediaContainerAi : styles.mediaContainer}>
          {media.map((item) => {
            if (item.type === 'image' || item.type === 'gif') {
              const imageUrl = getMediaUrl(item.id);
              return (
                <Image
                  key={item.id}
                  source={{ uri: imageUrl }}
                  style={isAiMessage ? styles.mediaImageAi : styles.mediaImage}
                />
              );
            }
            // TODO: Add video support
            return null;
          })}
        </View>
      )}
      {/* Text bubble - only shown if there's text */}
      {text ? (
        <View style={[
          !isAiMessage && styles.bubble,
          !isAiMessage && isSent && styles.bubbleSent,
          isAiMessage && styles.bubbleAi,
        ]}>
          <Text style={[
            !isAiMessage && styles.text,
            !isAiMessage && isSent && styles.textSent,
            isAiMessage && styles.textAi,
          ]}>
            {text}
          </Text>
        </View>
      ) : null}
      {showTimestamp && (
        <Text
          style={[
            styles.timestamp,
            isAiMessage && styles.timestampAi,
            !isAiMessage && isSent ? styles.timestampSent : styles.timestampReceived,
          ]}
        >
          {timeString}
        </Text>
      )}
    </TouchableOpacity>
  );
});

MessageBubble.displayName = 'MessageBubble';

