/**
 * "RESTORE YOUR HISTORY?" — asked once, at first run, of a device that has
 * nothing and whose account has a backup.
 *
 * The conditions, all of them from the SDK:
 *
 *  - the instance is `active` (a pending device has no store to restore into,
 *    and a revoked one has its own screen);
 *  - the server holds a backup for the account, which is only known after
 *    `refreshStatus()` has asked — asked once per client here, and the answer
 *    lands in `status.remote`;
 *  - the backup is not already enabled on THIS device (a device that keeps the
 *    backup has nothing to restore);
 *  - no conversation on this device has any decrypted history yet. A fresh
 *    device already lists the account's conversation rows — `joined: false`,
 *    empty timelines — so the test is on the timelines, never on the list;
 *  - this instance has not answered the prompt before (`restorePromptStore`).
 *
 * It renders as a card over the bottom of the app, not a modal: the app is
 * usable behind it, and it never holds boot. "Restore" goes to the backup
 * screen, whose restore section is the same one this is a shortcut to; "Not
 * now" is remembered for this instance. Either way it is not shown again.
 *
 * Boot-mounted, so nothing here may suspend: `useTranslation` runs with
 * suspense off and every string has an inline default.
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { useAlloClient, useBackup, useConversations, useInstanceState } from '@allo/react';

import { useTheme } from '@/hooks/useTheme';
import { useRestorePromptStore } from '@/stores/restorePromptStore';
import { logger } from '@/utils/logger';

export function RestoreHistoryPrompt() {
  const client = useAlloClient();
  const { state } = useInstanceState();
  const { status, refreshStatus } = useBackup();
  const conversations = useConversations();
  const instanceId = state === 'active' ? client.instanceId : null;
  const answered = useRestorePromptStore((store) => (instanceId ? store.answeredInstanceIds[instanceId] === true : true));
  const markAnswered = useRestorePromptStore((store) => store.markAnswered);
  // Which instance the server has been asked about, so it is asked once per client.
  const askedFor = useRef<string | null>(null);

  useEffect(() => {
    if (instanceId === null || answered || askedFor.current === instanceId) return;
    askedFor.current = instanceId;
    refreshStatus().catch((error: unknown) => {
      logger.warn('[allo] the server could not be asked whether a backup exists', error);
    });
  }, [answered, instanceId, refreshStatus]);

  const hasHistory = useMemo(
    () => conversations.some((conversation) => client.messages.timeline(conversation.id).length > 0),
    [client, conversations],
  );

  const visible = instanceId !== null && !answered && status.remote?.exists === true && !status.enabled && !hasHistory;

  const answer = useCallback(
    (restore: boolean) => {
      if (instanceId !== null) markAnswered(instanceId);
      if (restore) router.push('/settings/backup');
    },
    [instanceId, markAnswered],
  );

  if (!visible) return null;
  return <RestoreHistoryCard onRestore={() => answer(true)} onNotNow={() => answer(false)} />;
}

interface RestoreHistoryCardProps {
  onRestore: () => void;
  onNotNow: () => void;
}

export function RestoreHistoryCard({ onRestore, onNotNow }: RestoreHistoryCardProps) {
  const { t } = useTranslation(undefined, { useSuspense: false });
  const styles = useCardStyles();
  return (
    <View style={styles.host} pointerEvents="box-none">
      <View style={styles.card} accessibilityRole="alert" testID="restore-prompt">
        <Text style={styles.title}>{t('restorePrompt.title', 'Restore your history?')}</Text>
        <Text style={styles.body}>
          {t('restorePrompt.body', 'This account has an encrypted backup. Enter your recovery phrase to bring your conversations to this device.')}
        </Text>
        <View style={styles.actions}>
          <TouchableOpacity onPress={onNotNow} style={styles.secondaryButton} accessibilityRole="button" testID="restore-prompt-not-now">
            <Text style={styles.secondaryButtonText}>{t('restorePrompt.notNow', 'Not now')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onRestore} style={styles.primaryButton} accessibilityRole="button" testID="restore-prompt-restore">
            <Text style={styles.primaryButtonText}>{t('restorePrompt.restore', 'Restore')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </View>
  );
}

function useCardStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        host: {
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          padding: 16,
          paddingBottom: 96,
          alignItems: 'center',
        },
        card: {
          width: '100%',
          maxWidth: 480,
          padding: 16,
          borderRadius: 16,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.card,
          gap: 8,
          shadowColor: theme.colors.shadow,
          shadowOpacity: 0.15,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 4 },
          elevation: 6,
        },
        title: {
          fontSize: 16,
          fontWeight: '700',
          color: theme.colors.text,
        },
        body: {
          fontSize: 14,
          lineHeight: 20,
          color: theme.colors.textSecondary,
        },
        actions: {
          flexDirection: 'row',
          justifyContent: 'flex-end',
          gap: 8,
          marginTop: 4,
        },
        primaryButton: {
          paddingVertical: 10,
          paddingHorizontal: 20,
          borderRadius: 20,
          backgroundColor: theme.colors.primary,
        },
        primaryButtonText: {
          fontSize: 14,
          fontWeight: '600',
          color: theme.colors.background,
        },
        secondaryButton: {
          paddingVertical: 10,
          paddingHorizontal: 16,
          borderRadius: 20,
        },
        secondaryButtonText: {
          fontSize: 14,
          fontWeight: '600',
          color: theme.colors.primary,
        },
      }),
    [theme],
  );
}
