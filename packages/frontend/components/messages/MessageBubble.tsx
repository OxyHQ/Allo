import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS } from '@/constants/messaging';
import { useMessagePreferencesStore } from '@/stores';
import { MessageMetadata } from './MessageMetadata';

/**
 * Message type enum
 */
export type MessageType = 'user' | 'ai';

/**
 * Props for MessageBubble component
 * 
 * Simplified component that only handles individual message bubbles.
 * Media handling is done at MessageBlock level.
 */
export interface MessageBubbleProps {
  /** Unique identifier for the message */
  id: string;
  /** Message text content */
  text: string;
  /** Timestamp when the message was sent */
  timestamp: Date;
  /** Whether the message was sent by the current user */
  isSent: boolean;
  /** Optional sender name (for group conversations) */
  senderName?: string;
  /** Whether to display the sender name */
  showSenderName: boolean;
  /** Whether to display the timestamp */
  showTimestamp: boolean;
  /** Whether this message is close to the previous one (for spacing) */
  isCloseToPrevious?: boolean;
  /** Type of message: 'user' (with bubble) or 'ai' (plain text, no bubble) */
  messageType?: MessageType;
  /** Read status for sent messages */
  readStatus?: 'sent' | 'delivered' | 'read';
  /** Whether the message was edited */
  isEdited?: boolean;
  /** Custom font size for this message (if adjusted via send button) */
  fontSize?: number;
}

/**
 * MessageBubble Component
 * 
 * Displays a single message bubble with optional sender name, timestamp, and media.
 * Optimized with React.memo and useMemo for performance.
 * 
 * Features:
 * - Supports both user messages (with bubbles) and AI messages (plain text)
 * - Media attachments (images, gifs) rendered separately from text bubble
 * - Responsive spacing based on message grouping
 * - Accessible with proper test IDs
 * 
 * @example
 * ```tsx
 * <MessageBubble
 *   id="msg-1"
 *   text="Hello!"
 *   timestamp={new Date()}
 *   isSent={true}
 *   showTimestamp={true}
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
  readStatus,
  isEdited = false,
  fontSize,
}) => {
  const theme = useTheme();
  const defaultMessageTextSize = useMessagePreferencesStore((state) => state.messageTextSize);
  // Use custom fontSize if provided, otherwise use default
  const messageTextSize = fontSize ?? defaultMessageTextSize;
  
  // Memoize computed values
  const isAiMessage = messageType === 'ai';
  const hasText = Boolean(text && text.trim().length > 0);
  
  // Calculate margin top based on context
  const marginTop = useMemo(() => {
    if (showSenderName) {
      return MESSAGING_CONSTANTS.MESSAGE_SPACING_WITH_SENDER;
    }
    if (isCloseToPrevious) {
      return MESSAGING_CONSTANTS.MESSAGE_MARGIN_CLOSE;
    }
    return 0; // No margin when in a block - spacing handled at block level
  }, [showSenderName, isCloseToPrevious]);
  
  // Memoize styles to prevent recalculation on every render
  const styles = useMemo(() => {
    // Use tighter line height for more compact bubbles (WhatsApp-style)
    const lineHeight = messageTextSize * 1.25;
    
    return StyleSheet.create({
      container: {
        flexDirection: 'column',
        marginTop,
        maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MAX_MESSAGE_WIDTH,
        alignSelf: 'flex-start',
      },
      containerSent: {
        alignSelf: 'flex-end',
        alignItems: 'flex-end',
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
        paddingHorizontal: 0,
        paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
        borderRadius: 0,
        backgroundColor: 'transparent',
      },
      textContainer: {
        flexDirection: 'row',
        alignItems: 'flex-end',
      },
      textWrapper: {
        flex: 1,
        flexShrink: 1,
      },
      text: {
        fontSize: messageTextSize,
        lineHeight,
        color: colors.messageTextReceived,
      },
      textSent: {
        color: colors.messageTextSent,
      },
      textAi: {
        fontSize: messageTextSize,
        lineHeight,
        color: theme.colors.text || colors.messageTextReceived,
      },
      metadataContainer: {
        flexDirection: 'row',
        alignItems: 'center',
        marginLeft: 4,
        paddingBottom: 0,
        flexShrink: 0,
      },
    });
  }, [marginTop, theme.colors.textSecondary, theme.colors.text, isAiMessage, messageTextSize]);
  
  const shouldShowMetadata = !isAiMessage && showTimestamp;
  
  // Memoize container style array
  const containerStyle = useMemo<StyleProp<ViewStyle>>(() => [
    styles.container,
    !isAiMessage && isSent && styles.containerSent,
  ], [styles, isAiMessage, isSent]);
  
  // Memoize bubble style array
  const bubbleStyle = useMemo<StyleProp<ViewStyle>>(() => [
    !isAiMessage && styles.bubble,
    !isAiMessage && isSent && styles.bubbleSent,
    isAiMessage && styles.bubbleAi,
  ], [styles, isAiMessage, isSent]);
  
  // Memoize text style array
  const textStyle = useMemo<StyleProp<TextStyle>>(() => [
    !isAiMessage && styles.text,
    !isAiMessage && isSent && styles.textSent,
    isAiMessage && styles.textAi,
  ], [styles, isAiMessage, isSent]);
  
  if (!hasText) {
    return null;
  }

  return (
    <View
      style={containerStyle}
      testID={`message-${id}`}
      accessibilityRole="text"
      accessibilityLabel={`Message from ${senderName || (isSent ? 'you' : 'sender')}`}
    >
      {showSenderName && senderName && (
        <ThemedText style={styles.senderName}>
          {senderName}
        </ThemedText>
      )}
      
      <View style={bubbleStyle}>
        <View style={styles.textContainer}>
          <View style={styles.textWrapper}>
            <Text style={textStyle}>
              {text}
            </Text>
          </View>
          {shouldShowMetadata && (
            <View style={styles.metadataContainer}>
              <MessageMetadata
                timestamp={timestamp}
                isSent={isSent}
                isEdited={isEdited}
                readStatus={readStatus}
                showTimestamp={showTimestamp}
                variant="bubble"
              />
            </View>
          )}
        </View>
      </View>
    </View>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function for better memoization
  // Returns true if props are equal (component should NOT re-render)
  
  if (
    prevProps.id !== nextProps.id ||
    prevProps.text !== nextProps.text ||
    prevProps.isSent !== nextProps.isSent ||
    prevProps.senderName !== nextProps.senderName ||
    prevProps.showSenderName !== nextProps.showSenderName ||
    prevProps.showTimestamp !== nextProps.showTimestamp ||
    prevProps.isCloseToPrevious !== nextProps.isCloseToPrevious ||
    prevProps.messageType !== nextProps.messageType
  ) {
    return false;
  }
  
  // Timestamp comparison
  if (prevProps.timestamp.getTime() !== nextProps.timestamp.getTime()) {
    return false;
  }
  
  return true;
});

MessageBubble.displayName = 'MessageBubble';
