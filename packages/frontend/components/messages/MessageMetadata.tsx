import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import { colors } from '@/styles/colors';
import { MsgDblCheckIcon } from '@/assets/icons/msgdblcheck-icon';
import { MsgCheckIcon } from '@/assets/icons/msgcheck-icon';
import { MsgPendingIcon } from '@/assets/icons/msgpending-icon';

export interface MessageMetadataProps {
  timestamp: Date;
  isSent?: boolean;
  isEdited?: boolean;
  readStatus?: 'sent' | 'delivered' | 'read';
  showTimestamp?: boolean;
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
}) => {
  const theme = useTheme();

  const timeString = useMemo(
    () => timestamp.toLocaleTimeString([], TIME_FORMAT_OPTIONS),
    [timestamp]
  );

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      marginTop: 4,
      alignSelf: isSent ? 'flex-end' : 'flex-start',
    },
    timestamp: {
      fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      color: colors.messageTimestamp || theme.colors.textSecondary || '#999999',
    },
    editedLabel: {
      fontSize: MESSAGING_CONSTANTS.TIMESTAMP_SIZE,
      color: colors.messageTimestamp || theme.colors.textSecondary || '#999999',
      fontStyle: 'italic',
    },
    readIndicator: {
      marginLeft: 2,
    },
  }), [isSent, readStatus, theme]);

  const readIndicatorColor = useMemo(() => {
    if (readStatus === 'read') {
      return colors.buttonPrimary || colors.primaryColor || theme.colors.primary || '#007AFF';
    }
    return colors.messageTimestamp || theme.colors.textSecondary || '#999999';
  }, [readStatus, theme]);

  const statusIcon = useMemo(() => {
    if (!isSent || !readStatus) return null;
    const commonProps = { size: 16, color: readIndicatorColor };

    switch (readStatus) {
      case 'read':
        return <MsgDblCheckIcon {...commonProps} />;
      case 'delivered':
        return <MsgCheckIcon {...commonProps} />;
      case 'sent':
      default:
        return <MsgPendingIcon {...commonProps} />;
    }
  }, [isSent, readStatus, readIndicatorColor]);

  if (!showTimestamp) {
    return null;
  }

  return (
    <View style={styles.container}>
      {timeString && (
        <Text style={styles.timestamp}>{timeString}</Text>
      )}
      {isEdited && (
        <Text style={styles.editedLabel}>edited</Text>
      )}
      {statusIcon && (
        <View style={styles.readIndicator}>
          {statusIcon}
        </View>
      )}
    </View>
  );
});

MessageMetadata.displayName = 'MessageMetadata';
