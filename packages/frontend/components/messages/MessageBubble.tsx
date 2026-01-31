import React, { memo, useMemo } from 'react';
import { View, Text, StyleProp, ViewStyle, TextStyle } from 'react-native';
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
  readStatus?: 'pending' | 'sent' | 'delivered' | 'read';
  /** Whether the message was edited */
  isEdited?: boolean;
  /** Custom font size for this message (if adjusted via send button) */
  fontSize?: number;
  /** Optional override for bubble background color (for previews) */
  bubbleColor?: string;
  /** Optional override for text color (for previews) */
  textColor?: string;
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
  bubbleColor,
  textColor,
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
  
  // Memoize dynamic text styles
  const textStyles = useMemo(() => {
    const lineHeight = messageTextSize * 1.25;
    return {
      fontSize: messageTextSize,
      lineHeight,
    };
  }, [messageTextSize]);

  // Memoize bubble background color
  const bubbleBackgroundColor = useMemo(() =>
    bubbleColor || (isSent ? theme.colors.messageBubbleSent : theme.colors.messageBubbleReceived),
    [bubbleColor, isSent, theme.colors.messageBubbleSent, theme.colors.messageBubbleReceived]
  );

  // Memoize text color
  const messageTextColor = useMemo(() => {
    if (isAiMessage) return theme.colors.text;
    return textColor || (isSent ? theme.colors.messageTextSent : theme.colors.messageTextReceived);
  }, [textColor, isSent, isAiMessage, theme.colors.text, theme.colors.messageTextSent, theme.colors.messageTextReceived]);
  
  const shouldShowMetadata = !isAiMessage && showTimestamp;
  
  if (!hasText) {
    return null;
  }

  return (
    <View
      className="flex-col self-start"
      style={{
        marginTop,
        maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MAX_MESSAGE_WIDTH,
        ...((!isAiMessage && isSent) && { alignSelf: 'flex-end', alignItems: 'flex-end' }),
      }}
      testID={`message-${id}`}
      accessibilityRole="text"
      accessibilityLabel={`Message from ${senderName || (isSent ? 'you' : 'sender')}`}
    >
      {showSenderName && senderName && (
        <ThemedText
          className="font-semibold mb-[1px] ml-2.5"
          style={{
            fontSize: MESSAGING_CONSTANTS.SENDER_NAME_SIZE,
            color: theme.colors.textSecondary,
          }}
        >
          {senderName}
        </ThemedText>
      )}

      <View
        style={{
          paddingHorizontal: isAiMessage ? 0 : MESSAGING_CONSTANTS.MESSAGE_PADDING_HORIZONTAL,
          paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
          borderRadius: isAiMessage ? 0 : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
          backgroundColor: isAiMessage ? 'transparent' : bubbleBackgroundColor,
        }}
      >
        <View className="flex-row items-end">
          <View className="flex-1 shrink">
            <Text style={{ ...textStyles, color: messageTextColor }}>
              {text}
            </Text>
          </View>
          {shouldShowMetadata && (
            <View className="flex-row items-center ml-1 pb-0 shrink-0">
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
    prevProps.messageType !== nextProps.messageType ||
    prevProps.bubbleColor !== nextProps.bubbleColor ||
    prevProps.textColor !== nextProps.textColor ||
    prevProps.fontSize !== nextProps.fontSize
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
