import React, { useMemo } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Ionicons } from '@expo/vector-icons';

import { useEphemeralLifetimes } from '@/components/matrix/ephemeralLifetimes';
import { ThemedText } from '@/components/ThemedText';
import { useTheme } from '@/hooks/useTheme';
import type { AlloEphemeralPolicy } from '@/lib/matrix/types';

/**
 * A strip under the header saying that this conversation's messages disappear.
 *
 * **This is the visual distinction the tier needs, and it has to be permanent.**
 * An ephemeral conversation is identical to an ordinary one — same bubbles, same
 * composer, same padlock — until its messages start vanishing, which is after
 * the moment anybody could have decided differently. A badge that only appeared
 * in the settings screen would leave the person typing with no way to know.
 *
 * It says how long, and it says one more thing on purpose: *on this device*.
 * That is the whole shape of the promise. The other people in the room are not
 * told the conversation is ephemeral — nothing in Matrix that both halves of the
 * port can reach carries it — so what is guaranteed is that this device stops
 * showing these messages and takes its own off the homeserver. Saying "messages
 * disappear" without saying whose would be the sentence a reader would trust
 * with something they should not.
 */

export function EphemeralBanner({ policy }: { readonly policy: AlloEphemeralPolicy }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();
  const { labelFor } = useEphemeralLifetimes();

  return (
    <View style={styles.banner} accessibilityRole="summary">
      <Ionicons name="timer-outline" size={16} color={theme.colors.primary} />
      <ThemedText style={styles.text}>
        {t('Messages disappear from this device after {{duration}}. Your own are deleted for everyone.', {
          duration: labelFor(policy.lifetimeMs),
        })}
      </ThemedText>
    </View>
  );
}

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        banner: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
          paddingHorizontal: 16,
          paddingVertical: 8,
          backgroundColor: theme.colors.backgroundSecondary,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: theme.colors.border,
        },
        text: {
          flex: 1,
          fontSize: 13,
          color: theme.colors.textSecondary,
        },
      }),
    [theme.colors],
  );
}
