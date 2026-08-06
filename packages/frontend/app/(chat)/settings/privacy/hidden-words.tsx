import React, { useCallback, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, TouchableOpacity, View } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { TextFieldInput } from '@oxyhq/bloom';
import { Button } from '@oxyhq/bloom/button';
import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { toast } from '@oxyhq/bloom/toast';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { EmptyState } from '@/components/shared/EmptyState';
import { ThemedView } from '@/components/ThemedView';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { useTheme } from '@/hooks/useTheme';
import {
  addHiddenWord,
  HIDDEN_WORD_MAX_LENGTH,
  removeHiddenWord,
  type HiddenWordRejection,
} from '@/lib/privacy/hiddenWords';
import { confirmDialog } from '@/utils/alerts';

/**
 * THE WORDS THIS READER DOES NOT WANT TO SEE.
 *
 * A list on the privacy document, edited here: add one, take one away. The rules
 * about what counts as the same word live in `lib/privacy/hiddenWords.ts` and are
 * tested there, because "is `Spoilers` already in the list" is a question with a
 * right answer that rendering cannot be asked.
 *
 * Every edit writes the WHOLE list, because that is what the endpoint takes —
 * `hiddenWords` is `$set` wholesale. So the new list is computed from the one on
 * screen, which is the one the query holds, which is the one the server last
 * answered with.
 */

/** Why the field refused what was typed. */
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
        onError: () => {
          toast.error(t('settings.privacy.updateError'));
        },
      },
    );
  }, [draft, t, updateSettings, words]);

  const remove = useCallback(
    async (word: string) => {
      const confirmed = await confirmDialog({
        title: t('settings.privacy.hiddenWordRemove'),
        message: t('settings.privacy.hiddenWordRemoveConfirm', { word }),
        okText: t('settings.privacy.hiddenWordRemove'),
        cancelText: t('common.cancel'),
        destructive: true,
      });
      if (!confirmed) return;

      updateSettings.mutate(
        { hiddenWords: removeHiddenWord(words, word) },
        {
          onSuccess: () => {
            toast.success(t('settings.privacy.hiddenWordRemoved'));
          },
          onError: () => {
            toast.error(t('settings.privacy.updateError'));
          },
        },
      );
    },
    [t, updateSettings, words],
  );

  const styles = StyleSheet.create({
    composer: {
      paddingHorizontal: 16,
      paddingTop: 12,
      gap: 12,
    },
    centred: {
      alignItems: 'center',
      paddingVertical: 24,
    },
  });

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.privacy.hiddenWords'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

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

      <ScrollView className="flex-1" contentContainerClassName="px-4 pt-4 pb-6">
        {!saved && !failed ? (
          <View style={styles.centred}>
            <ActivityIndicator size="large" color={theme.colors.primary} />
          </View>
        ) : words.length === 0 ? (
          <EmptyState
            lottieSource={require('@/assets/lottie/welcome.json')}
            title={t('settings.privacy.noHiddenWords')}
            subtitle={t('settings.privacy.hiddenWordsDescription')}
          />
        ) : (
          <SettingsListGroup footer={t('settings.privacy.hiddenWordsDescription')}>
            {words.map((word) => (
              <SettingsListItem
                key={word}
                title={word}
                showChevron={false}
                rightElement={
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('settings.privacy.hiddenWordRemove')}
                    disabled={updateSettings.isPending}
                    onPress={() => {
                      void remove(word);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  >
                    <Ionicons name="close-circle" size={22} color={theme.colors.error} />
                  </TouchableOpacity>
                }
              />
            ))}
          </SettingsListGroup>
        )}
      </ScrollView>
    </ThemedView>
  );
}
