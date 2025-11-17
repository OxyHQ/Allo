import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { MESSAGING_CONSTANTS, TIME_FORMAT_OPTIONS } from '@/constants/messaging';
import { colors } from '@/styles/colors';

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
    checkIcon: {
      fontSize: 14,
      color: readStatus === 'read' 
        ? colors.buttonPrimary || '#007AFF'
        : colors.messageTimestamp || theme.colors.textSecondary || '#999999',
    },
  }), [isSent, readStatus, theme]);

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
      {isSent && readStatus && (
        <View style={styles.readIndicator}>
          <Text style={styles.checkIcon}>
            {readStatus === 'read' ? '✓✓' : readStatus === 'delivered' ? '✓✓' : '✓'}
          </Text>
        </View>
      )}
    </View>
  );
});

MessageMetadata.displayName = 'MessageMetadata';

