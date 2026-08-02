import React from 'react';
import { View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';

/**
 * The warning a user reads before linking a network that bans unofficial clients.
 *
 * ## Why this is not a footnote
 *
 * Linking WhatsApp or Meta means a bridge signing in as an additional device with
 * software those networks did not write. `docs/matrix/bridges.md` §8 is built
 * around the consequence: they act on correlated egress, which is why those
 * networks need a per-user residential proxy and why they are the only ones that
 * declare `requiresProxy`. The proxy reduces one signal. It does not make the
 * client official, and the account at risk is the user's, not Allo's.
 *
 * So the decision is theirs, taken with the fact in front of them at the moment
 * they make it. §11 makes the same argument about Telegram's secret chats: a
 * limitation a user discovers afterwards is a complaint they are right to make.
 *
 * ## Which networks
 *
 * Never named here. The caller decides with `requiresBanWarning`, which reads the
 * server's `requiresProxy`. A component that checked for "whatsapp" would be a
 * second list of networks in a codebase whose whole design says there is none —
 * and it would silently fail to warn the day Messenger is turned on.
 */

export interface BanRiskWarningProps {
  readonly networkDisplayName: string;
}

export function BanRiskWarning({ networkDisplayName }: BanRiskWarningProps) {
  const { t } = useTranslation();
  const theme = useTheme();

  return (
    <View
      className="mb-4 flex-row rounded-2xl p-4"
      style={{ backgroundColor: theme.colors.backgroundSecondary }}
      accessibilityRole="alert"
    >
      <Ionicons
        name="warning-outline"
        size={20}
        color={theme.colors.warning}
        style={{ marginTop: 2 }}
      />
      <View className="ml-3 flex-1">
        <ThemedText className="font-semibold" style={{ color: theme.colors.text }}>
          {t('bridges.warning.banRisk.title', {
            network: networkDisplayName,
            defaultValue: '{{network}} may ban this account',
          })}
        </ThemedText>
        <ThemedText
          className="mt-1 text-sm"
          style={{ color: theme.colors.textSecondary }}
        >
          {t('bridges.warning.banRisk.body', {
            network: networkDisplayName,
            defaultValue:
              'Allo connects to {{network}} with an unofficial client. {{network}} does not allow this and may restrict or permanently ban your account there. Allo cannot appeal or recover it for you.',
          })}
        </ThemedText>
      </View>
    </View>
  );
}
