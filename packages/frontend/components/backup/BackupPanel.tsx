import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RecoveryPhraseError, useBackup } from '@allo/react';
import { Button } from '@oxy.so/bloom/button';
import {
  RiCheckboxBlankCircleLine,
  RiCheckboxCircleFill,
  RiFileCopyLine,
  RiShieldCheckLine,
  RiShieldLine,
} from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { normalizeRecoveryPhrase, RECOVERY_PHRASE_WORDS, recoveryPhraseWordCount } from '@/lib/allo/recoveryPhrase';
import { confirm } from '@oxy.so/bloom/surfaces';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * ENCRYPTED BACKUP AND RECOVERY, as one panel over the SDK's `backup` topic.
 *
 *  - The status: on or off here, the last backup and what it covered, and
 *    whether the server holds one for the account — known only once
 *    `refreshStatus()` has asked, so it is asked on mount and drawn as
 *    "checking" until then.
 *  - Turning it on hands back the 12-word recovery phrase EXACTLY ONCE. It is
 *    held in this component's state while on screen, never logged and never
 *    persisted by the app (the SDK keeps only the derived key), and it cannot be
 *    dismissed until the person says they wrote it down; `onPhrasePending` lets
 *    the screen around it refuse to be left meanwhile.
 *  - Restoring from a phrase, offered when the server has a backup and this
 *    device is not keeping it. The restore section keys on `status.remote`, not
 *    on an empty conversation list: a fresh device already lists the account's
 *    conversations (unjoined, empty) before it has restored anything. A wrong
 *    phrase is refused before any download (`RecoveryPhraseError`).
 */
export interface BackupPanelProps {
  /** Called with `true` while the phrase is on screen and unconfirmed, and `false` once it is not. */
  onPhrasePending?: (pending: boolean) => void;
}

export function BackupPanel({ onPhrasePending }: BackupPanelProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const { status, enable, refresh, disable, restore, refreshStatus } = useBackup();

  const [phrase, setPhrase] = useState<string | null>(null);
  const [wroteDown, setWroteDown] = useState(false);
  const [action, setAction] = useState<'enable' | 'refresh' | 'disable' | 'restore' | null>(null);
  const [restoreInput, setRestoreInput] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    refreshStatus().catch((error: unknown) => {
      logger.warn('[Backup] the server could not be asked for the backup status', error);
    });
  }, [refreshStatus]);

  const phrasePending = phrase !== null;
  useEffect(() => {
    onPhrasePending?.(phrasePending);
    return () => onPhrasePending?.(false);
  }, [onPhrasePending, phrasePending]);

  const busy = action !== null || status.busy;

  const turnOn = useCallback(async () => {
    if (busy) return;
    setAction('enable');
    try {
      const words = await enable();
      setWroteDown(false);
      setPhrase(words);
    } catch (error: unknown) {
      logger.error('[Backup] enable failed', error);
      toast.error(getErrorMessage(error) || t('backup.enableFailed'));
    } finally {
      setAction(null);
    }
  }, [busy, enable, t]);

  const backUpNow = useCallback(async () => {
    if (busy) return;
    setAction('refresh');
    try {
      await refresh();
      toast.success(t('backup.refreshed'));
    } catch (error: unknown) {
      logger.error('[Backup] refresh failed', error);
      toast.error(getErrorMessage(error) || t('backup.refreshFailed'));
    } finally {
      setAction(null);
    }
  }, [busy, refresh, t]);

  const turnOff = useCallback(async () => {
    if (busy) return;
    const confirmed = await confirm({
      title: t('backup.turnOffConfirmTitle'),
      description: t('backup.turnOffConfirm'),
      confirmLabel: t('backup.turnOff'),
      cancelLabel: t('common.cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setAction('disable');
    try {
      await disable();
      toast.success(t('backup.disabled'));
    } catch (error: unknown) {
      logger.error('[Backup] disable failed', error);
      toast.error(getErrorMessage(error) || t('backup.disableFailed'));
    } finally {
      setAction(null);
    }
  }, [busy, disable, t]);

  const copyPhrase = useCallback(async () => {
    if (phrase === null) return;
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(phrase);
      toast.success(t('backup.phrase.copied'));
    } catch (error: unknown) {
      // The error, never the phrase.
      logger.error('[Backup] the phrase could not be copied', error);
      toast.error(t('backup.phrase.copyFailed'));
    }
  }, [phrase, t]);

  const dismissPhrase = useCallback(() => {
    if (!wroteDown) return;
    setPhrase(null);
    setWroteDown(false);
  }, [wroteDown]);

  const runRestore = useCallback(async () => {
    if (busy) return;
    setRestoreError(null);
    setAction('restore');
    try {
      await restore(normalizeRecoveryPhrase(restoreInput));
      setRestoreInput('');
      toast.success(t('backup.restore.done'));
    } catch (error: unknown) {
      if (error instanceof RecoveryPhraseError) {
        setRestoreError(t('backup.restore.wrongPhrase'));
      } else {
        logger.error('[Backup] restore failed', error);
        setRestoreError(t('backup.restore.failed'));
      }
    } finally {
      setAction(null);
    }
  }, [busy, restore, restoreInput, t]);

  const words = useMemo(() => (phrase === null ? [] : phrase.split(' ')), [phrase]);
  const typedWords = recoveryPhraseWordCount(restoreInput);
  const showRestore = status.remote?.exists === true && !status.enabled;
  const StatusIcon = status.enabled ? RiShieldCheckLine : RiShieldLine;

  return (
    <View style={styles.root}>
      <SettingsListGroup title={t('backup.section.status')} footer={t('backup.explain')}>
        <SettingsListItem
          icon={<StatusIcon width={20} height={20} fill={status.enabled ? theme.colors.success : theme.colors.textSecondary} />}
          title={status.enabled ? t('backup.status.on') : t('backup.status.off')}
          description={
            status.lastBackupAt
              ? t('backup.status.lastBackup', { when: formatWhen(status.lastBackupAt) })
              : t('backup.status.never')
          }
          value={status.enabled ? t('backup.status.events', { count: status.eventCount }) : undefined}
        />
        <SettingsListItem
          title={
            status.remote === null
              ? t('backup.status.remoteUnknown')
              : status.remote.exists
                ? t('backup.status.remoteExists')
                : t('backup.status.remoteMissing')
          }
        />
      </SettingsListGroup>

      <View style={styles.actions}>
        {status.enabled ? (
          <>
            <Button
              testID="backup-refresh"
              variant="primary"
              style={styles.action}
              loading={action === 'refresh' || (action === null && status.busy)}
              disabled={busy}
              onPress={() => void backUpNow()}
            >
              {t('backup.backUpNow')}
            </Button>
            <Button
              testID="backup-disable"
              variant="secondary"
              style={styles.action}
              loading={action === 'disable'}
              disabled={busy}
              onPress={() => void turnOff()}
            >
              {t('backup.turnOff')}
            </Button>
          </>
        ) : (
          <Button
            testID="backup-enable"
            variant="primary"
            style={styles.action}
            loading={action === 'enable'}
            disabled={busy || phrasePending}
            onPress={() => void turnOn()}
          >
            {t('backup.turnOn')}
          </Button>
        )}
      </View>

      {phrase !== null ? (
        <SettingsListGroup title={t('backup.phrase.title')}>
          <View style={styles.card} testID="backup-phrase">
            <Text style={[styles.body, { color: theme.colors.text }]}>{t('backup.phrase.body')}</Text>
            <View style={styles.grid} accessibilityLabel={t('backup.phrase.title')}>
              {words.map((word, index) => (
                <View key={`${index}-${word}`} style={styles.cell}>
                  <Text style={[styles.cellIndex, { color: theme.colors.textTertiary }]}>{index + 1}</Text>
                  <Text style={[styles.cellWord, { color: theme.colors.text }]} testID={`backup-word-${index + 1}`} selectable>
                    {word}
                  </Text>
                </View>
              ))}
            </View>
            <Button testID="backup-copy" variant="secondary" leadingIcon={RiFileCopyLine} onPress={() => void copyPhrase()}>
              {t('backup.phrase.copy')}
            </Button>
            <Pressable
              testID="backup-confirm"
              style={styles.check}
              onPress={() => setWroteDown((value) => !value)}
              accessibilityRole="checkbox"
              aria-checked={wroteDown}
            >
              {wroteDown ? (
                <RiCheckboxCircleFill width={22} height={22} fill={theme.colors.primary} />
              ) : (
                <RiCheckboxBlankCircleLine width={22} height={22} fill={theme.colors.textSecondary} />
              )}
              <Text style={[styles.checkLabel, { color: theme.colors.text }]}>{t('backup.phrase.confirm')}</Text>
            </Pressable>
            {!wroteDown ? <Muted>{t('backup.phrase.mustConfirm')}</Muted> : null}
            <Button testID="backup-done" variant="primary" disabled={!wroteDown} onPress={dismissPhrase}>
              {t('common.done')}
            </Button>
          </View>
        </SettingsListGroup>
      ) : null}

      {showRestore ? (
        <SettingsListGroup title={t('backup.restore.title')}>
          <View style={styles.card} testID="backup-restore-section">
            <Text style={[styles.body, { color: theme.colors.text }]}>{t('backup.restore.body')}</Text>
            <Textarea
              testID="backup-restore-input"
              accessibilityLabel={t('backup.restore.title')}
              placeholder={t('backup.restore.placeholder')}
              value={restoreInput}
              onChangeText={(value) => {
                setRestoreInput(value.toLowerCase());
                if (restoreError !== null) setRestoreError(null);
              }}
              isInvalid={restoreError !== null}
              rows={3}
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              textContentType="none"
              disabled={action === 'restore'}
            />
            <Muted>{t('backup.restore.count', { count: typedWords, total: RECOVERY_PHRASE_WORDS })}</Muted>
            {restoreError !== null ? (
              <Text
                style={[styles.error, { color: theme.colors.error }]}
                testID="backup-restore-error"
                accessibilityLiveRegion="polite"
              >
                {restoreError}
              </Text>
            ) : null}
            <Button
              testID="backup-restore"
              variant="primary"
              loading={action === 'restore'}
              disabled={busy || typedWords !== RECOVERY_PHRASE_WORDS}
              onPress={() => void runRestore()}
            >
              {t('backup.restore.button')}
            </Button>
          </View>
        </SettingsListGroup>
      ) : null}
    </View>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

const styles = StyleSheet.create({
  root: { gap: 4 },
  actions: { flexDirection: 'row', gap: 12, marginBottom: 16 },
  action: { flex: 1 },
  card: { padding: 16, gap: 10 },
  body: { fontSize: 14, lineHeight: 20 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginVertical: 4 },
  cell: {
    width: '33.333%',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: 6,
    paddingVertical: 6,
    paddingHorizontal: 4,
  },
  cellIndex: { fontSize: 12, fontVariant: ['tabular-nums'], minWidth: 16, textAlign: 'right' },
  cellWord: { fontSize: 16, fontWeight: '600' },
  check: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 6 },
  checkLabel: { fontSize: 15 },
  error: { fontSize: 13 },
});
