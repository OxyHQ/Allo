import React, { useCallback } from 'react';
import { ActivityIndicator, ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { toast } from '@oxyhq/bloom/toast';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { ThemedView } from '@/components/ThemedView';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { useTheme } from '@/hooks/useTheme';
import { PROFILE_VISIBILITIES, type ProfileVisibility } from '@/lib/privacy/api';
import {
  profileVisibilityDescriptionKey,
  profileVisibilityLabelKey,
} from '@/lib/privacy/labels';

/**
 * WHO MAY SEE THIS PROFILE — one of three.
 *
 * A screen and not a bottom sheet, and the reason is consistency rather than
 * taste: `settings/language` is the same problem — pick one of a short list of
 * mutually exclusive values — and it is a screen with a tick beside the current
 * one. Two shapes for one interaction would mean a reader learns the app twice,
 * and a sheet additionally hides the choice they are changing behind the gesture
 * that opens it. When Allo has a control that genuinely benefits from staying in
 * context, a sheet is the right answer for that one.
 *
 * The values come from `PROFILE_VISIBILITIES` rather than being listed again
 * here, so a change to what the backend accepts shows up as a row rather than as
 * a silently missing option.
 */
export default function ProfileVisibilityScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  const { settings, saved } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const choose = useCallback(
    (profileVisibility: ProfileVisibility) => {
      if (profileVisibility === settings.profileVisibility) return;
      updateSettings.mutate(
        { profileVisibility },
        {
          onSuccess: () => {
            toast.success(t('settings.privacy.profileVisibilityUpdated'));
          },
          onError: () => {
            toast.error(t('settings.privacy.updateError'));
          },
        },
      );
    },
    [settings.profileVisibility, t, updateSettings],
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.privacy.privateProfile'),
          leftComponents: [
            <HeaderIconButton key="back" onPress={() => router.back()}>
              <BackArrowIcon size={20} color={theme.colors.text} />
            </HeaderIconButton>,
          ],
        }}
        hideBottomBorder={true}
        disableSticky={true}
      />

      <ScrollView
        className="flex-1"
        contentContainerClassName="px-4 pt-5 pb-6"
        showsVerticalScrollIndicator={false}
      >
        <SettingsListGroup footer={t('settings.privacy.description')}>
          {PROFILE_VISIBILITIES.map((visibility) => {
            const isSelected = settings.profileVisibility === visibility;
            const isSaving = updateSettings.isPending && updateSettings.variables?.profileVisibility === visibility;

            return (
              <SettingsListItem
                key={visibility}
                title={t(profileVisibilityLabelKey(visibility))}
                description={t(profileVisibilityDescriptionKey(visibility))}
                onPress={() => choose(visibility)}
                // Until the stored value has arrived, every row would be drawn
                // against the schema default rather than against the reader's
                // own setting, and tapping the one already chosen would look
                // like it did nothing.
                disabled={!saved || updateSettings.isPending}
                showChevron={false}
                rightElement={
                  isSaving ? (
                    <ActivityIndicator size="small" color={theme.colors.primary} />
                  ) : isSelected ? (
                    <Ionicons name="checkmark-circle" size={24} color={theme.colors.primary} />
                  ) : null
                }
              />
            );
          })}
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}
