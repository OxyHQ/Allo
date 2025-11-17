import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';

export interface MessageBubbleProps {
  id: string;
  text: string;
  timestamp: Date;
  isSent: boolean;
  senderName?: string;
  showSenderName: boolean;
  showTimestamp: boolean;
  isCloseToPrevious?: boolean;
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
  onPress,
}) => {
  const theme = useTheme();
  
  const timeString = useMemo(
    () => timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS),
    [timestamp]
  );
  
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
      text: {
        fontSize: MESSAGING_CONSTANTS.MESSAGE_TEXT_SIZE,
        color: colors.messageTextReceived,
      },
      textSent: {
        color: colors.messageTextSent,
      },
      timestamp: {
        fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
        color: colors.messageTimestamp,
        marginTop: 4,
      },
      timestampSent: {
        alignSelf: 'flex-end',
      },
      timestampReceived: {
        alignSelf: 'flex-start',
      },
    });
  }, [theme.colors.textSecondary]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={onPress}
      style={[
        styles.container,
        isSent && styles.containerSent,
        showSenderName && styles.containerWithSender,
      ]}
      testID={`message-${id}`}
    >
      {showSenderName && senderName && (
        <ThemedText style={styles.senderName}>{senderName}</ThemedText>
      )}
      <View style={[styles.bubble, isSent && styles.bubbleSent]}>
        <Text style={[styles.text, isSent && styles.textSent]}>
          {text}
        </Text>
      </View>
      {showTimestamp && (
        <Text
          style={[
            styles.timestamp,
            isSent ? styles.timestampSent : styles.timestampReceived,
          ]}
        >
          {timeString}
        </Text>
      )}
    </TouchableOpacity>
  );
});

MessageBubble.displayName = 'MessageBubble';

