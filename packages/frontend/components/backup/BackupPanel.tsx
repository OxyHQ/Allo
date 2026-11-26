import { RecoveryPhraseError, useBackup } from '@allo/react';
import { RiFileCopyLine } from '@oxy.so/bloom/icons/RiFileCopyLine';
import { Textarea } from '@oxy.so/bloom/textarea';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Text } from '@oxy.so/bloom/typography';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { StyleSheet, View } from 'react-native';

import {
  normalizeRecoveryPhrase,
  RECOVERY_PHRASE_WORDS,
  recoveryPhraseWordCount,
} from '@/lib/allo/recoveryPhrase';
import { getErrorMessage } from '@/utils/errors';
import { formatWhen } from '@/utils/formatWhen';
import { logger } from '@/utils/logger';
import { confirm } from '@oxy.so/bloom/surfaces';

import {
  Button as LButton,
  Embed,
  Group,
  HStack,
  Icon,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import {
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
} from '@oxy.so/bloom-language/containers';
import { Checkbox as LCheckbox } from '@oxy.so/bloom-language/inputs';
import {
  SettingsSection as LSettingsSection,
  SettingsValue,
} from '@oxy.so/bloom-language/settings';

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

  return toElement(
    VStack(
      LSettingsSection(
        t('backup.section.status'),
        LGroupedSection(
          LGroupedSectionItem(status.enabled ? t('backup.status.on') : t('backup.status.off'))
            .lines(0)
            .descriptionLines(0)
            .wrapControl()
            .description(
              status.lastBackupAt
                ? t('backup.status.lastBackup', {
                    when: formatWhen(status.lastBackupAt),
                  })
                : t('backup.status.never'),
            )
            .trailing(
              status.enabled
                ? SettingsValue(t('backup.status.events', { count: status.eventCount }))
                : null,
            ),
          LGroupedSectionItem(
            status.remote === null
              ? t('backup.status.remoteUnknown')
              : status.remote.exists
                ? t('backup.status.remoteExists')
                : t('backup.status.remoteMissing'),
          )
            .lines(0)
            .descriptionLines(0)
            .wrapControl(),
        ),
      ).description(t('backup.explain')),
      HStack(
        status.enabled
          ? Group(
              LButton(LText(t('backup.backUpNow')))
                .testID('backup-refresh')
                .loading(action === 'refresh' || (action === null && status.busy))
                .disabled(busy)
                .onPress(() => void backUpNow())
                .tint('accent')
                .style('solid')
                .grow(),
              LButton(LText(t('backup.turnOff')))
                .testID('backup-disable')
                .loading(action === 'disable')
                .disabled(busy)
                .onPress(() => void turnOff())
                .tint('neutral')
                .style('outline')
                .grow(),
            )
          : LButton(LText(t('backup.turnOn')))
              .testID('backup-enable')
              .loading(action === 'enable')
              .disabled(busy || phrasePending)
              .onPress(() => void turnOn())
              .tint('accent')
              .style('solid')
              .grow(),
      )
        .spacing('md')
        .margin('top', 'md')
        .margin('bottom', 'lg'),
      phrase !== null
        ? LSettingsSection(
            t('backup.phrase.title'),
            LGroupedSection(
              VStack(
                LText(t('backup.phrase.body')).font('14').leading('20px').foreground('foreground'),
                HStack(
                  Embed(
                    words.map((word, index) => (
                      <View key={`${index}-${word}`} style={styles.cell}>
                        <Text style={[styles.cellIndex, { color: theme.colors.textTertiary }]}>
                          {index + 1}
                        </Text>
                        <Text
                          style={[styles.cellWord, { color: theme.colors.text }]}
                          testID={`backup-word-${index + 1}`}
                          selectable
                        >
                          {word}
                        </Text>
                      </View>
                    )),
                  ),
                )
                  .wrap()
                  .margin('vertical', 'xs')
                  .label(t('backup.phrase.title')),
                LButton(Icon(RiFileCopyLine), LText(t('backup.phrase.copy')))
                  .testID('backup-copy')
                  .onPress(() => void copyPhrase())
                  .tint('neutral')
                  .style('outline'),
                LCheckbox([wroteDown, setWroteDown], t('backup.phrase.confirm')).testID(
                  'backup-confirm',
                ),
                !wroteDown ? LText(t('backup.phrase.mustConfirm')).textStyle('muted') : null,
                LButton(LText(t('common.done')))
                  .testID('backup-done')
                  .disabled(!wroteDown)
                  .onPress(dismissPhrase)
                  .tint('accent')
                  .style('solid'),
              )
                .padding('all', 'lg')
                .spacing('10')
                .testID('backup-phrase'),
            ),
          )
        : null,
      showRestore
        ? LSettingsSection(
            t('backup.restore.title'),
            LGroupedSection(
              VStack(
                LText(t('backup.restore.body')).font('14').leading('20px').foreground('foreground'),
                Embed(
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
                  />,
                ),
                LText(
                  t('backup.restore.count', {
                    count: typedWords,
                    total: RECOVERY_PHRASE_WORDS,
                  }),
                ).textStyle('muted'),
                restoreError !== null
                  ? LText(restoreError)
                      .font('sm')
                      .foreground('error')
                      .testID('backup-restore-error')
                      .liveRegion('polite')
                  : null,
                LButton(LText(t('backup.restore.button')))
                  .testID('backup-restore')
                  .loading(action === 'restore')
                  .disabled(busy || typedWords !== RECOVERY_PHRASE_WORDS)
                  .onPress(() => void runRestore())
                  .tint('accent')
                  .style('solid'),
              )
                .padding('all', 'lg')
                .spacing('10')
                .testID('backup-restore-section'),
            ),
          )
        : null,
    ).spacing('xs'),
  );
}

const styles = StyleSheet.create({
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
    minWidth: 16,
    textAlign: 'right',
  },

  cellWord: { fontSize: 16, fontWeight: '600' },
});
