import React, { memo, useMemo, useCallback } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Image, StyleProp, ViewStyle, TextStyle } from 'react-native';
import { ThemedText } from '@/components/ThemedText';
import { colors } from '@/styles/colors';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import type { MediaItem } from '@/stores';
import { useMessagePreferencesStore } from '@/stores';

/**
 * Message type enum
 */
export type MessageType = 'user' | 'ai';

/**
 * Props for MessageBubble component
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
  /** Array of media attachments */
  media?: MediaItem[];
  /** Function to get media URL from media ID */
  getMediaUrl?: (mediaId: string) => string;
  /** Callback when message is pressed */
  onPress: () => void;
}

/**
 * Props for MediaItem component
 */
interface MediaItemProps {
  item: MediaItem;
  isAiMessage: boolean;
  getMediaUrl: (mediaId: string) => string;
}

/**
 * Renders a single media item (image or gif)
 * Memoized for performance
 */
const MediaItemComponent = memo<MediaItemProps>(({ item, isAiMessage, getMediaUrl }) => {
  if (item.type !== 'image' && item.type !== 'gif') {
    return null;
  }

  const imageUrl = getMediaUrl(item.id);
  const styles = useMemo(() => StyleSheet.create({
    image: {
      width: '100%',
      maxWidth: MESSAGING_CONSTANTS.MEDIA_MAX_WIDTH,
      height: MESSAGING_CONSTANTS.MEDIA_HEIGHT,
      resizeMode: 'cover' as const,
      borderRadius: isAiMessage 
        ? MESSAGING_CONSTANTS.MEDIA_BORDER_RADIUS_AI 
        : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
    },
  }), [isAiMessage]);

  return (
    <Image
      key={item.id}
      source={{ uri: imageUrl }}
      style={styles.image}
      accessibilityLabel={`Media attachment: ${item.type}`}
    />
  );
});

MediaItemComponent.displayName = 'MediaItem';

/**
 * Props for MediaContainer component
 */
interface MediaContainerProps {
  media: MediaItem[];
  isAiMessage: boolean;
  getMediaUrl: (mediaId: string) => string;
}

/**
 * Renders media container with all media items
 * Memoized for performance
 */
const MediaContainer = memo<MediaContainerProps>(({ media, isAiMessage, getMediaUrl }) => {
  const styles = useMemo(() => StyleSheet.create({
    container: {
      marginBottom: MESSAGING_CONSTANTS.MEDIA_MARGIN_BOTTOM,
      borderRadius: isAiMessage 
        ? MESSAGING_CONSTANTS.MEDIA_BORDER_RADIUS_AI 
        : MESSAGING_CONSTANTS.MESSAGE_BUBBLE_BORDER_RADIUS,
      overflow: 'hidden' as const,
      backgroundColor: 'transparent',
    },
  }), [isAiMessage]);

  if (!media || media.length === 0) {
    return null;
  }

  return (
    <View style={styles.container}>
      {media.map((item) => (
        <MediaItemComponent
          key={item.id}
          item={item}
          isAiMessage={isAiMessage}
          getMediaUrl={getMediaUrl}
        />
      ))}
    </View>
  );
});

MediaContainer.displayName = 'MediaContainer';

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
  const messageTextSize = useMessagePreferencesStore((state) => state.messageTextSize);
  
  // Memoize computed values
  const isAiMessage = messageType === 'ai';
  const hasText = Boolean(text && text.trim().length > 0);
  const hasMedia = Boolean(media && media.length > 0 && getMediaUrl);
  
  // Memoize time string formatting
  const timeString = useMemo(
    () => timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS),
    [timestamp]
  );
  
  // Calculate margin top based on context
  const marginTop = useMemo(() => {
    if (showSenderName) {
      return MESSAGING_CONSTANTS.MESSAGE_SPACING_WITH_SENDER;
    }
    if (isCloseToPrevious) {
      return MESSAGING_CONSTANTS.MESSAGE_MARGIN_CLOSE;
    }
    return MESSAGING_CONSTANTS.MESSAGE_MARGIN_VERTICAL;
  }, [showSenderName, isCloseToPrevious]);
  
  // Memoize styles to prevent recalculation on every render
  const styles = useMemo(() => {
    const lineHeight = messageTextSize * MESSAGING_CONSTANTS.LINE_HEIGHT_MULTIPLIER;
    
    return StyleSheet.create({
      container: {
        flexDirection: 'column',
        marginTop,
        marginBottom: MESSAGING_CONSTANTS.MESSAGE_MARGIN_VERTICAL,
        maxWidth: isAiMessage ? '100%' : MESSAGING_CONSTANTS.MAX_MESSAGE_WIDTH,
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
        paddingHorizontal: 0,
        paddingVertical: MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
        borderRadius: 0,
        backgroundColor: 'transparent',
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
      timestamp: {
        fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
        color: colors.messageTimestamp,
        marginTop: 4,
      },
      timestampAi: {
        marginTop: -MESSAGING_CONSTANTS.MESSAGE_PADDING_VERTICAL,
      },
      timestampSent: {
        alignSelf: 'flex-end',
      },
      timestampReceived: {
        alignSelf: 'flex-start',
      },
    });
  }, [marginTop, theme.colors.textSecondary, theme.colors.text, isAiMessage, messageTextSize]);
  
  // Memoize container style array
  const containerStyle = useMemo<StyleProp<ViewStyle>>(() => [
    styles.container,
    !isAiMessage && isSent && styles.containerSent,
    showSenderName && styles.containerWithSender,
  ], [styles, isAiMessage, isSent, showSenderName]);
  
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
  
  // Memoize timestamp style array
  const timestampStyle = useMemo<StyleProp<TextStyle>>(() => [
    styles.timestamp,
    isAiMessage && styles.timestampAi,
    !isAiMessage && isSent ? styles.timestampSent : styles.timestampReceived,
  ], [styles, isAiMessage, isSent]);
  
  // Memoize press handler to prevent unnecessary re-renders
  const handlePress = useCallback(() => {
    onPress();
  }, [onPress]);

  return (
    <TouchableOpacity
      activeOpacity={0.9}
      onPress={handlePress}
      style={containerStyle}
      testID={`message-${id}`}
      accessibilityRole="button"
      accessibilityLabel={`Message from ${senderName || (isSent ? 'you' : 'sender')}`}
    >
      {showSenderName && senderName && (
        <ThemedText style={styles.senderName}>
          {senderName}
        </ThemedText>
      )}
      
      {hasMedia && getMediaUrl && (
        <MediaContainer
          media={media}
          isAiMessage={isAiMessage}
          getMediaUrl={getMediaUrl}
        />
      )}
      
      {hasText && (
        <View style={bubbleStyle}>
          <Text style={textStyle}>
            {text}
          </Text>
        </View>
      )}
      
      {showTimestamp && (
        <Text style={timestampStyle}>
          {timeString}
        </Text>
      )}
    </TouchableOpacity>
  );
}, (prevProps, nextProps) => {
  // Custom comparison function for better memoization
  // Returns true if props are equal (component should NOT re-render)
  
  // Quick reference equality checks first (fastest)
  if (
    prevProps.id !== nextProps.id ||
    prevProps.text !== nextProps.text ||
    prevProps.isSent !== nextProps.isSent ||
    prevProps.senderName !== nextProps.senderName ||
    prevProps.showSenderName !== nextProps.showSenderName ||
    prevProps.showTimestamp !== nextProps.showTimestamp ||
    prevProps.isCloseToPrevious !== nextProps.isCloseToPrevious ||
    prevProps.messageType !== nextProps.messageType ||
    prevProps.onPress !== nextProps.onPress ||
    prevProps.getMediaUrl !== nextProps.getMediaUrl
  ) {
    return false;
  }
  
  // Timestamp comparison
  if (prevProps.timestamp.getTime() !== nextProps.timestamp.getTime()) {
    return false;
  }
  
  // Media array comparison (shallow)
  const prevMedia = prevProps.media || [];
  const nextMedia = nextProps.media || [];
  
  if (prevMedia.length !== nextMedia.length) {
    return false;
  }
  
  for (let i = 0; i < prevMedia.length; i++) {
    if (
      prevMedia[i].id !== nextMedia[i].id ||
      prevMedia[i].type !== nextMedia[i].type
    ) {
      return false;
    }
  }
  
  return true;
});

MessageBubble.displayName = 'MessageBubble';
