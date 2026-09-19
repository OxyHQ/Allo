import React, { useCallback, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button, GlyphButton } from '@oxy.so/bloom/button';
import { RiCloseCircleLine } from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { TextFieldInput } from '@oxy.so/bloom/text-field';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted } from '@oxy.so/bloom/typography';

import { Page } from '@/components/shell/Page';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import {
  addHiddenWord,
  HIDDEN_WORD_MAX_LENGTH,
  removeHiddenWord,
  type HiddenWordRejection,
} from '@/lib/privacy/hiddenWords';
import { confirm } from '@oxy.so/bloom/surfaces';

/**
 * THE WORDS THIS READER DOES NOT WANT TO SEE: add one, take one away.
 *
 * What counts as the same word lives in `lib/privacy/hiddenWords.ts` and is
 * tested there. Every edit writes the WHOLE list, because the endpoint sets
 * `hiddenWords` wholesale, so the new list is computed from the one on screen —
 * the one the server last answered with.
 */

const REJECTION_KEYS: Record<HiddenWordRejection, string> = {
  empty: 'settings.privacy.hiddenWordEmpty',
  'too-long': 'settings.privacy.hiddenWordTooLong',
  duplicate: 'settings.privacy.hiddenWordDuplicate',
};

export default function HiddenWordsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { settings, saved, failed } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();
  const [draft, setDraft] = useState('');
  const words = settings.hiddenWords;

  const add = useCallback(() => {
    const result = addHiddenWord(words, draft);
    if (!result.ok) {
      toast.error(t(REJECTION_KEYS[result.reason]));
      return;
    }
    updateSettings.mutate(
      { hiddenWords: result.words },
      {
        onSuccess: () => {
          setDraft('');
          toast.success(t('settings.privacy.hiddenWordAdded'));
        },
        onError: () => toast.error(t('settings.privacy.updateError')),
      },
    );
  }, [draft, t, updateSettings, words]);

  const remove = useCallback(
    async (word: string) => {
      const confirmed = await confirm({
        title: t('settings.privacy.hiddenWordRemove'),
        description: t('settings.privacy.hiddenWordRemoveConfirm', { word }),
        confirmLabel: t('settings.privacy.hiddenWordRemove'),
        cancelLabel: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;
      updateSettings.mutate(
        { hiddenWords: removeHiddenWord(words, word) },
        {
          onSuccess: () => toast.success(t('settings.privacy.hiddenWordRemoved')),
          onError: () => toast.error(t('settings.privacy.updateError')),
        },
      );
    },
    [t, updateSettings, words],
  );

  return (
    <Page title={t('settings.privacy.hiddenWords')}>
      <View style={styles.composer}>
        <TextFieldInput
          label={t('settings.privacy.hiddenWordLabel')}
          placeholder={t('settings.privacy.hiddenWordPlaceholder')}
          value={draft}
          onChangeText={setDraft}
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={HIDDEN_WORD_MAX_LENGTH}
          returnKeyType="done"
          onSubmitEditing={add}
        />
        <Button
          variant="primary"
          disabled={!saved || draft.trim().length === 0}
          loading={updateSettings.isPending}
          onPress={add}
        >
          {t('settings.privacy.add')}
        </Button>
      </View>

      {!saved && !failed ? (
        <View style={styles.centred}>
          <ActivityIndicator color={theme.colors.primary} />
        </View>
      ) : failed ? (
        <Muted style={styles.centredText}>{t('settings.privacy.loadError')}</Muted>
      ) : words.length === 0 ? (
        <View style={styles.centred}>
          <Muted style={styles.centredText}>{t('settings.privacy.noHiddenWords')}</Muted>
          <Muted style={styles.centredText}>{t('settings.privacy.hiddenWordsDescription')}</Muted>
        </View>
      ) : (
        <SettingsListGroup footer={t('settings.privacy.hiddenWordsDescription')}>
          {words.map((word) => (
            <SettingsListItem
              key={word}
              title={word}
              showChevron={false}
              rightElement={
                <GlyphButton
                  icon={RiCloseCircleLine}
                  color={theme.colors.error}
                  accessibilityLabel={t('settings.privacy.hiddenWordRemove')}
                  disabled={updateSettings.isPending}
                  onPress={() => void remove(word)}
                />
              }
            />
          ))}
        </SettingsListGroup>
      )}
    </Page>
  );
}

const styles = StyleSheet.create({
  composer: { gap: 12 },
  centred: { alignItems: 'center', paddingVertical: 24, gap: 6 },
  centredText: { textAlign: 'center' },
});
