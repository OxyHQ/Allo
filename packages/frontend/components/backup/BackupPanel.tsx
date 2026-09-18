import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, Text, TextInput, TouchableOpacity, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';
import { useTranslation } from 'react-i18next';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { toast } from '@oxy.so/bloom/toast';
import { RecoveryPhraseError, useBackup } from '@allo/react';

import { useTheme } from '@/hooks/useTheme';
import { normalizeRecoveryPhrase, RECOVERY_PHRASE_WORDS, recoveryPhraseWordCount } from '@/lib/allo/recoveryPhrase';
import { confirmDialog } from '@/utils/alerts';
import { getErrorMessage } from '@/utils/errors';
import { logger } from '@/utils/logger';

/**
 * ENCRYPTED BACKUP AND RECOVERY, as one panel.
 *
 * Three things, from the SDK's `backup` topic:
 *
 *  - The status: on or off here, when the last backup was made and how much it
 *    covered, and whether the server holds one for the account at all — which
 *    is only known after `refreshStatus()` has asked, so that is asked once on
 *    mount and the answer is drawn as "checking" until it lands.
 *  - Turning it on, which hands back the 12-word recovery phrase EXACTLY ONCE.
 *    The phrase is held in this component's state while it is on screen, is
 *    never logged and never persisted by the app (the SDK keeps only the key it
 *    derives), and the panel refuses to let the words go until the person has
 *    said they wrote them down: `onPhrasePending` tells the screen around it to
 *    block leaving meanwhile.
 *  - Restoring from a phrase, offered when the server has a backup and this
 *    device is not the one keeping it. A wrong phrase is refused by the SDK
 *    before anything is downloaded (`RecoveryPhraseError`) and is drawn as the
 *    friendly message it deserves; anything else is a generic failure.
 *
 * Why the restore section keys on `status.remote?.exists` rather than on an
 * empty conversation list: a fresh device already sees the account's
 * conversation rows (with `joined: false` and empty timelines) before it has
 * restored anything, so "the list is empty" is not a signal it can use.
 *
 * Plain React Native primitives and `theme.colors.*` only; the route around it
 * adds the header and the back button.
 */
export interface BackupPanelProps {
  /** Called with `true` while the phrase is on screen and unconfirmed, and `false` once it is not. */
  onPhrasePending?: (pending: boolean) => void;
}

export function BackupPanel({ onPhrasePending }: BackupPanelProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const styles = useStyles();
  const { status, enable, refresh, disable, restore, refreshStatus } = useBackup();

  const [phrase, setPhrase] = useState<string | null>(null);
  const [wroteDown, setWroteDown] = useState(false);
  const [action, setAction] = useState<'enable' | 'refresh' | 'disable' | 'restore' | null>(null);
  const [restoreInput, setRestoreInput] = useState('');
  const [restoreError, setRestoreError] = useState<string | null>(null);

  useEffect(() => {
    // Once on mount: whether the server holds a backup is not known until asked.
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
      toast.error(getErrorMessage(error) || t('backup.enableFailed', 'The backup could not be turned on'));
    } finally {
      setAction(null);
    }
  }, [busy, enable, t]);

  const backUpNow = useCallback(async () => {
    if (busy) return;
    setAction('refresh');
    try {
      await refresh();
      toast.success(t('backup.refreshed', 'Backed up'));
    } catch (error: unknown) {
      logger.error('[Backup] refresh failed', error);
      toast.error(getErrorMessage(error) || t('backup.refreshFailed', 'The backup could not be refreshed'));
    } finally {
      setAction(null);
    }
  }, [busy, refresh, t]);

  const turnOff = useCallback(async () => {
    if (busy) return;
    const confirmed = await confirmDialog({
      title: t('backup.turnOffConfirmTitle', 'Turn off backup?'),
      message: t('backup.turnOffConfirm', 'The backup on the server is deleted and this device forgets the key. A device that loses its history will have nothing to restore from.'),
      okText: t('backup.turnOff', 'Turn off'),
      cancelText: t('common.cancel', 'Cancel'),
      destructive: true,
    });
    if (!confirmed) return;
    setAction('disable');
    try {
      await disable();
      toast.success(t('backup.disabled', 'Backup turned off'));
    } catch (error: unknown) {
      logger.error('[Backup] disable failed', error);
      toast.error(getErrorMessage(error) || t('backup.disableFailed', 'The backup could not be turned off'));
    } finally {
      setAction(null);
    }
  }, [busy, disable, t]);

  const copyPhrase = useCallback(async () => {
    if (phrase === null) return;
    try {
      const Clipboard = await import('expo-clipboard');
      await Clipboard.setStringAsync(phrase);
      toast.success(t('backup.phrase.copied', 'Copied. Clear your clipboard once the words are written down.'));
    } catch (error: unknown) {
      // The error, never the phrase.
      logger.error('[Backup] the phrase could not be copied', error);
      toast.error(t('backup.phrase.copyFailed', 'The phrase could not be copied'));
    }
  }, [phrase, t]);

  const dismissPhrase = useCallback(() => {
    if (!wroteDown) return;
    setPhrase(null);
    setWroteDown(false);
  }, [wroteDown]);

  const runRestore = useCallback(async () => {
    if (busy) return;
    const normalized = normalizeRecoveryPhrase(restoreInput);
    setRestoreError(null);
    setAction('restore');
    try {
      await restore(normalized);
      setRestoreInput('');
      toast.success(t('backup.restore.done', 'History restored'));
    } catch (error: unknown) {
      if (error instanceof RecoveryPhraseError) {
        setRestoreError(t('backup.restore.wrongPhrase', 'That is not the recovery phrase for this backup. Check the words and their order.'));
      } else {
        logger.error('[Backup] restore failed', error);
        setRestoreError(t('backup.restore.failed', 'The backup could not be restored. Try again.'));
      }
    } finally {
      setAction(null);
    }
  }, [busy, restore, restoreInput, t]);

  const words = useMemo(() => (phrase === null ? [] : phrase.split(' ')), [phrase]);
  const typedWords = recoveryPhraseWordCount(restoreInput);
  const showRestore = status.remote?.exists === true && !status.enabled;

  return (
    <View>
      <SettingsListGroup title={t('backup.section.status', 'Status')}>
        <View style={styles.card}>
          <View style={styles.statusRow}>
            <Ionicons
              name={status.enabled ? 'cloud-done-outline' : 'cloud-offline-outline'}
              size={22}
              color={status.enabled ? theme.colors.success : theme.colors.textSecondary}
            />
            <Text style={styles.statusTitle} testID="backup-status">
              {status.enabled ? t('backup.status.on', 'Backup is on') : t('backup.status.off', 'Backup is off')}
            </Text>
          </View>
          <Text style={styles.detail}>
            {status.lastBackupAt
              ? t('backup.status.lastBackup', 'Last backup {{when}}', { when: formatWhen(status.lastBackupAt) })
              : t('backup.status.never', 'Never backed up from this device')}
          </Text>
          {status.enabled ? (
            <Text style={styles.detail}>{t('backup.status.events', '{{count}} messages and changes covered', { count: status.eventCount })}</Text>
          ) : null}
          <Text style={styles.detail} testID="backup-remote">
            {status.remote === null
              ? t('backup.status.remoteUnknown', 'Checking the server…')
              : status.remote.exists
                ? t('backup.status.remoteExists', 'A backup for this account is on the server')
                : t('backup.status.remoteMissing', 'No backup on the server')}
          </Text>
          <Text style={styles.explain}>
            {t(
              'backup.explain',
              'Your conversations are encrypted with a key only your recovery phrase can unlock, then kept on the server. The phrase is shown once and never leaves this device.',
            )}
          </Text>
          <View style={styles.actions}>
            {status.enabled ? (
              <>
                <ActionButton
                  testID="backup-refresh"
                  label={t('backup.backUpNow', 'Back up now')}
                  onPress={() => { void backUpNow(); }}
                  busy={action === 'refresh' || (action === null && status.busy)}
                  disabled={busy}
                  styles={styles}
                />
                <ActionButton
                  testID="backup-disable"
                  label={t('backup.turnOff', 'Turn off')}
                  onPress={() => { void turnOff(); }}
                  busy={action === 'disable'}
                  disabled={busy}
                  styles={styles}
                  secondary
                  destructive
                />
              </>
            ) : (
              <ActionButton
                testID="backup-enable"
                label={t('backup.turnOn', 'Turn on')}
                onPress={() => { void turnOn(); }}
                busy={action === 'enable'}
                disabled={busy || phrasePending}
                styles={styles}
              />
            )}
          </View>
        </View>
      </SettingsListGroup>

      {phrase !== null ? (
        <SettingsListGroup title={t('backup.phrase.title', 'Your recovery phrase')}>
          <View style={[styles.card, styles.phraseCard]} testID="backup-phrase">
            <Text style={styles.body}>
              {t(
                'backup.phrase.body',
                'Write these 12 words down, in order, and keep them somewhere safe. They are the only way to restore your history on a new device, and Allo cannot show them again.',
              )}
            </Text>
            <View style={styles.grid} accessibilityLabel={t('backup.phrase.title', 'Your recovery phrase')}>
              {words.map((word, index) => (
                <View key={`${index}-${word}`} style={styles.cell}>
                  <Text style={styles.cellIndex}>{index + 1}</Text>
                  <Text style={styles.cellWord} testID={`backup-word-${index + 1}`} selectable>
                    {word}
                  </Text>
                </View>
              ))}
            </View>
            <ActionButton
              testID="backup-copy"
              label={t('backup.phrase.copy', 'Copy')}
              onPress={() => { void copyPhrase(); }}
              styles={styles}
              secondary
            />
            <TouchableOpacity
              style={styles.checkRow}
              onPress={() => setWroteDown((value) => !value)}
              accessibilityRole="checkbox"
              accessibilityState={{ checked: wroteDown }}
              testID="backup-confirm"
            >
              <Ionicons name={wroteDown ? 'checkbox' : 'square-outline'} size={22} color={wroteDown ? theme.colors.primary : theme.colors.textSecondary} />
              <Text style={styles.checkLabel}>{t('backup.phrase.confirm', 'I wrote them down')}</Text>
            </TouchableOpacity>
            {!wroteDown ? <Text style={styles.hint}>{t('backup.phrase.mustConfirm', 'Confirm that you wrote the words down before leaving.')}</Text> : null}
            <ActionButton
              testID="backup-done"
              label={t('common.done', 'Done')}
              onPress={dismissPhrase}
              disabled={!wroteDown}
              styles={styles}
            />
          </View>
        </SettingsListGroup>
      ) : null}

      {showRestore ? (
        <SettingsListGroup title={t('backup.restore.title', 'Restore from recovery phrase')}>
          <View style={styles.card} testID="backup-restore-section">
            <Text style={styles.body}>
              {t('backup.restore.body', 'This account has a backup on the server. Enter the 12 words to restore your conversations on this device.')}
            </Text>
            <TextInput
              testID="backup-restore-input"
              style={styles.input}
              value={restoreInput}
              onChangeText={(value) => {
                setRestoreInput(value.toLowerCase());
                if (restoreError !== null) setRestoreError(null);
              }}
              placeholder={t('backup.restore.placeholder', 'word1 word2 word3 …')}
              placeholderTextColor={theme.colors.textTertiary}
              multiline
              autoCapitalize="none"
              autoCorrect={false}
              autoComplete="off"
              spellCheck={false}
              textContentType="none"
              editable={action !== 'restore'}
              accessibilityLabel={t('backup.restore.title', 'Restore from recovery phrase')}
            />
            <Text style={styles.hint}>{t('backup.restore.count', '{{count}} of {{total}} words', { count: typedWords, total: RECOVERY_PHRASE_WORDS })}</Text>
            {restoreError !== null ? (
              <Text style={styles.error} testID="backup-restore-error" accessibilityLiveRegion="polite">
                {restoreError}
              </Text>
            ) : null}
            <ActionButton
              testID="backup-restore"
              label={t('backup.restore.button', 'Restore')}
              onPress={() => { void runRestore(); }}
              busy={action === 'restore'}
              disabled={busy || typedWords !== RECOVERY_PHRASE_WORDS}
              styles={styles}
            />
          </View>
        </SettingsListGroup>
      ) : null}
    </View>
  );
}

interface ActionButtonProps {
  label: string;
  onPress: () => void;
  busy?: boolean;
  disabled?: boolean;
  secondary?: boolean;
  destructive?: boolean;
  testID: string;
  styles: ReturnType<typeof useStyles>;
}

function ActionButton({ label, onPress, busy = false, disabled = false, secondary = false, destructive = false, testID, styles }: ActionButtonProps) {
  const textStyle = [styles.buttonText, secondary && styles.secondaryButtonText, destructive && styles.destructiveButtonText];
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      style={[styles.button, secondary && styles.secondaryButton, disabled && styles.disabled]}
      accessibilityRole="button"
      accessibilityState={{ disabled, busy }}
    >
      {busy ? <ActivityIndicator color={secondary ? styles.secondaryButtonText.color : styles.buttonText.color} /> : <Text style={textStyle}>{label}</Text>}
    </TouchableOpacity>
  );
}

function formatWhen(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

function useStyles() {
  const theme = useTheme();
  return useMemo(
    () =>
      StyleSheet.create({
        card: {
          padding: 16,
          borderRadius: 12,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.backgroundSecondary,
          marginBottom: 12,
          gap: 8,
        },
        phraseCard: {
          borderColor: theme.colors.primary,
        },
        statusRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 8,
        },
        statusTitle: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
        },
        detail: {
          fontSize: 13,
          color: theme.colors.textSecondary,
        },
        explain: {
          fontSize: 13,
          lineHeight: 19,
          color: theme.colors.textSecondary,
          marginTop: 4,
        },
        body: {
          fontSize: 14,
          lineHeight: 20,
          color: theme.colors.text,
        },
        hint: {
          fontSize: 12,
          color: theme.colors.textSecondary,
        },
        error: {
          fontSize: 13,
          color: theme.colors.error,
        },
        actions: {
          gap: 8,
          marginTop: 8,
        },
        grid: {
          flexDirection: 'row',
          flexWrap: 'wrap',
          marginVertical: 4,
        },
        cell: {
          width: '33.333%',
          flexDirection: 'row',
          alignItems: 'baseline',
          gap: 6,
          paddingVertical: 6,
          paddingHorizontal: 4,
        },
        cellIndex: {
          fontSize: 12,
          fontVariant: ['tabular-nums'],
          color: theme.colors.textTertiary,
          minWidth: 16,
          textAlign: 'right',
        },
        cellWord: {
          fontSize: 16,
          fontWeight: '600',
          color: theme.colors.text,
        },
        checkRow: {
          flexDirection: 'row',
          alignItems: 'center',
          gap: 10,
          paddingVertical: 6,
        },
        checkLabel: {
          fontSize: 15,
          color: theme.colors.text,
        },
        input: {
          minHeight: 88,
          paddingVertical: 10,
          paddingHorizontal: 12,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: theme.colors.border,
          backgroundColor: theme.colors.background,
          color: theme.colors.text,
          fontSize: 16,
          lineHeight: 22,
          textAlignVertical: 'top',
        },
        button: {
          paddingVertical: 12,
          paddingHorizontal: 24,
          borderRadius: 24,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.colors.primary,
        },
        buttonText: {
          fontSize: 15,
          fontWeight: '600',
          color: theme.colors.background,
        },
        secondaryButton: {
          backgroundColor: theme.colors.background,
          borderWidth: 1,
          borderColor: theme.colors.border,
        },
        secondaryButtonText: {
          color: theme.colors.primary,
        },
        destructiveButtonText: {
          color: theme.colors.error,
        },
        disabled: { opacity: 0.6 },
      }),
    [theme],
  );
}
