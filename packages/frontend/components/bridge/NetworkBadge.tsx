/**
 * Interop bridge (F3.x) — small network badge.
 *
 * Renders a compact pill (e.g. "Telegram") identifying the external network a
 * bridged conversation rides on. Renders NOTHING for native Allo conversations,
 * so callers can mount it unconditionally.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { Network } from '@allo/shared-types';
import { useTheme } from '@/hooks/useTheme';
import { NETWORK_PRESENTATION, networkLabel } from '@/lib/bridge/networks';

const IconComponent = Ionicons as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

interface NetworkBadgeProps {
  network: Network | undefined;
  /** Visual size. `sm` is for list rows; `md` for the conversation header. */
  size?: 'sm' | 'md';
}

/** Compact, theme-aware network identity pill. Hidden for native Allo chats. */
export function NetworkBadge({ network, size = 'sm' }: NetworkBadgeProps) {
  const theme = useTheme();

  const isBridged = network !== undefined && network !== 'allo';
  const presentation = isBridged ? NETWORK_PRESENTATION[network] : undefined;

  const styles = useMemo(() => {
    const isSmall = size === 'sm';
    return StyleSheet.create({
      container: {
        flexDirection: 'row',
        alignItems: 'center',
        alignSelf: 'flex-start',
        borderRadius: 999,
        paddingHorizontal: isSmall ? 6 : 8,
        paddingVertical: isSmall ? 1 : 2,
        backgroundColor: theme.isDark ? 'rgba(255,255,255,0.10)' : 'rgba(0,0,0,0.06)',
        gap: isSmall ? 3 : 4,
      },
      label: {
        fontSize: isSmall ? 10 : 12,
        fontWeight: '600',
        color: theme.colors.textSecondary,
      },
    });
  }, [size, theme.isDark, theme.colors.textSecondary]);

  if (!isBridged || !presentation) return null;

  const iconSize = size === 'sm' ? 10 : 13;

  return (
    <View style={styles.container} accessibilityRole="text">
      <IconComponent name={presentation.icon} size={iconSize} color={presentation.color} />
      <Text style={styles.label} numberOfLines={1}>
        {networkLabel(network)}
      </Text>
    </View>
  );
}
