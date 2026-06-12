/**
 * Interop bridge (F3.x) — transparency banner.
 *
 * A persistent, NON-dismissable notice pinned inside a bridged conversation that
 * makes the security model explicit: bridged threads are NOT covered by Allo's
 * end-to-end encryption (the external network's encryption applies instead). This
 * is a deliberate honesty requirement — bridged content is plaintext to Allo's
 * server — so it must never be hidden or dismissed.
 */

import React, { useMemo } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';
import type { Network } from '@allo/shared-types';
import { useTheme } from '@/hooks/useTheme';
import { networkLabel } from '@/lib/bridge/networks';

const IconComponent = Ionicons as React.ComponentType<{
  name: string;
  size: number;
  color: string;
}>;

interface BridgeTransparencyBannerProps {
  network: Network;
}

/** Persistent, non-dismissable "not E2E encrypted" notice for bridged threads. */
export function BridgeTransparencyBanner({ network }: BridgeTransparencyBannerProps) {
  const theme = useTheme();
  const { t } = useTranslation();

  const styles = useMemo(
    () =>
      StyleSheet.create({
        container: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: theme.isDark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.04)',
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        text: {
          flex: 1,
          fontSize: 12,
          lineHeight: 16,
          color: theme.colors.textSecondary,
        },
      }),
    [theme.isDark, theme.colors.border, theme.colors.textSecondary]
  );

  return (
    <View
      style={styles.container}
      accessibilityRole="alert"
      accessibilityLabel={t('bridge.transparencyBanner', { network: networkLabel(network) })}
    >
      <IconComponent name="information-circle-outline" size={16} color={theme.colors.textSecondary} />
      <Text style={styles.text}>
        {t('bridge.transparencyBanner', { network: networkLabel(network) })}
      </Text>
    </View>
  );
}
