import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useTheme } from '@/hooks/useTheme';
import { formatDaySeparator } from '@/utils/messageGrouping';

export interface DaySeparatorProps {
  date: Date;
}

/**
 * DaySeparator Component
 * 
 * Displays a day separator in the message list, similar to WhatsApp.
 * Shows "Today", "Yesterday", or formatted date.
 * 
 * @example
 * ```tsx
 * <DaySeparator date={new Date()} />
 * ```
 */
export const DaySeparator = memo<DaySeparatorProps>(({ date }) => {
  const theme = useTheme();
  const label = formatDaySeparator(date);

  const styles = StyleSheet.create({
    container: {
      alignItems: 'center',
      justifyContent: 'center',
      paddingVertical: 12,
      paddingHorizontal: 16,
    },
    line: {
      position: 'absolute',
      left: 0,
      right: 0,
      height: 1,
      backgroundColor: theme.colors.border || '#E5E5E5',
    },
    label: {
      backgroundColor: theme.colors.background || '#FFFFFF',
      paddingHorizontal: 12,
      paddingVertical: 4,
      borderRadius: 12,
      fontSize: 12,
      fontWeight: '500',
      color: theme.colors.textSecondary || '#666666',
    },
  });

  return (
    <View style={styles.container}>
      <View style={styles.line} />
      <Text style={styles.label}>{label}</Text>
    </View>
  );
});

DaySeparator.displayName = 'DaySeparator';

