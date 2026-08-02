import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import { colors } from '@/styles/colors';
import { MsgDblCheckIcon } from '@/assets/icons/msgdblcheck-icon';
import { MsgCheckIcon } from '@/assets/icons/msgcheck-icon';
import { MsgPendingIcon } from '@/assets/icons/msgpending-icon';
import { MsgFailedIcon } from '@/assets/icons/msgfailed-icon';
import { statusMark, type MessageStatusMark } from '@/components/messages/messageStatus';
import type { MessageReadStatus } from '@/stores/messagesStore';

/** The picture for each mark. Which mark a status gets is `messageStatus.ts`. */
const MARK_ICONS: Record<
  MessageStatusMark,
  (props: { size: number; color: string }) => React.ReactElement
> = {
  clock: MsgPendingIcon,
  tick: MsgCheckIcon,
  'double-tick': MsgDblCheckIcon,
  error: MsgFailedIcon,
};

export interface MessageMetadataProps {
  timestamp: Date;
  isSent?: boolean;
  isEdited?: boolean;
  readStatus?: MessageReadStatus;
  showTimestamp?: boolean;
  variant?: 'default' | 'bubble';
}

/**
 * MessageMetadata Component
 * 
 * Displays message metadata including time, edited status, and read receipts.
 * Similar to WhatsApp's message status indicators.
 * 
 * @example
 * ```tsx
 * <MessageMetadata
 *   timestamp={new Date()}
 *   isSent={true}
 *   isEdited={false}
 *   readStatus="read"
 *   showTimestamp={true}
 * />
 * ```
 */
export const MessageMetadata = memo<MessageMetadataProps>(({
  timestamp,
  isSent = false,
  isEdited = false,
  readStatus,
  showTimestamp = true,
  variant = 'default',
}) => {
  const theme = useTheme();
  const isBubbleVariant = variant === 'bubble';

  const timeString = useMemo(
    () => timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS),
    [timestamp]
  );

  const timestampColor = useMemo(() => {
    if (isBubbleVariant) {
      return isSent ? 'rgba(255,255,255,0.85)' : 'rgba(26,32,44,0.7)';
    }
    return colors.messageTimestamp || theme.colors.textSecondary || '#999999';
  }, [isBubbleVariant, isSent, theme]);

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: isBubbleVariant ? 3 : 4,
      marginTop: isBubbleVariant ? 0 : 4,
      alignSelf: isBubbleVariant ? 'auto' : (isSent ? 'flex-end' : 'flex-start'),
      opacity: isBubbleVariant ? 1 : 1,
    },
    timestamp: {
      fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      color: timestampColor,
    },
    editedLabel: {
      fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      color: timestampColor,
      fontStyle: 'italic',
    },
    readIndicator: {
      justifyContent: 'center',
      alignItems: 'center',
      minWidth: isBubbleVariant ? 12 : 14,
      minHeight: isBubbleVariant ? 12 : 14,
    },
    separator: {
      fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      lineHeight: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      color: timestampColor,
    },
  }), [isBubbleVariant, isSent, theme, timestampColor]);

  const readIndicatorColor = useMemo(() => {
    // A failure is the one status that keeps its own colour inside a bubble.
    // Everything else on that background is deliberately quiet, and a mark the
    // user is meant to act on cannot be.
    if (readStatus === 'failed') {
      return theme.colors.error;
    }
    if (isBubbleVariant) {
      return timestampColor;
    }
    if (readStatus === 'read') {
      return colors.buttonPrimary || colors.primaryColor || theme.colors.primary || '#007AFF';
    }
    return colors.messageTimestamp || theme.colors.textSecondary || '#999999';
  }, [isBubbleVariant, readStatus, theme, timestampColor]);

  const statusIcon = useMemo(() => {
    if (!isSent || !readStatus) return null;
    const iconSize = isBubbleVariant ? MESSAGING_CONSTANTS.TIMESTAMP_SIZE : MESSAGING_CONSTANTS.TIMESTAMP_SIZE + 2;
    const Icon = MARK_ICONS[statusMark(readStatus)];

    return <Icon size={iconSize} color={readIndicatorColor} />;
  }, [isBubbleVariant, isSent, readStatus, readIndicatorColor]);

  if (!showTimestamp) {
    return null;
  }

  const metadataParts: React.ReactNode[] = [];

  if (timeString) {
    metadataParts.push(
      <Text key="time" style={styles.timestamp}>{timeString}</Text>
    );
  }

  if (isEdited) {
    metadataParts.push(
      <Text key="edited" style={styles.editedLabel}>edited</Text>
    );
  }

  if (statusIcon) {
    metadataParts.push(
      <View key="status" style={styles.readIndicator}>
        {statusIcon}
      </View>
    );
  }

  if (metadataParts.length === 0) {
    return null;
  }

  const shouldShowSeparator = !isBubbleVariant;

  return (
    <View style={styles.container}>
      {metadataParts.map((part, index) => (
        <React.Fragment key={`metadata-part-${index}`}>
          {index > 0 && shouldShowSeparator && (
            <Text style={styles.separator}>•</Text>
          )}
          {part}
        </React.Fragment>
      ))}
    </View>
  );
});

MessageMetadata.displayName = 'MessageMetadata';
