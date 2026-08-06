import React, { useCallback } from 'react';
import { ScrollView } from 'react-native';
import { router } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { useTranslation } from 'react-i18next';

import { SettingsListGroup, SettingsListItem } from '@oxyhq/bloom/settings-list';
import { Switch } from '@oxyhq/bloom/switch';
import { toast } from '@oxyhq/bloom/toast';

import { BackArrowIcon } from '@/assets/icons/back-arrow-icon';
import { Header } from '@/components/layout/Header';
import { HeaderIconButton } from '@/components/layout/HeaderIconButton';
import { ThemedView } from '@/components/ThemedView';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { useTheme } from '@/hooks/useTheme';
import { profileVisibilityLabelKey } from '@/lib/privacy/labels';

/**
 * WHAT ALLO CAN HONESTLY OFFER UNDER "PRIVACY".
 *
 * This list used to have seven rows and seven destinations, none of which
 * existed: every one was a tap that landed on "This screen does not exist". Two
 * of them could not be built at all, because they were about a product Allo is
 * not — "Tags and allos" and "Hide like and share counts" came over from Mention
 * with the settings schema, and Allo has no posts, no likes and no shares for
 * them to govern. They are gone. The fields stay in the backend document, which
 * other apps share; nothing here writes them.
 *
 * The five that remain are shaped by what they are, rather than all being rows
 * that push:
 *
 *   - **Online status** is ONE boolean, so it is a switch, here, in the list. A
 *     whole screen to hold a single toggle is a screen the reader has to leave
 *     again to find out whether it took.
 *   - **Profile visibility** is a choice of three, so it is a screen — the same
 *     shape as `settings/language`, which is also "pick one of a short list", and
 *     matching it means the two behave identically instead of one being a sheet
 *     that hides the current value behind a gesture.
 *   - **Blocked**, **Restricted** and **Hidden words** are LISTS. Each gets a
 *     screen that can show, add and remove.
 */
export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();

  const { settings, saved, failed } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const onToggleOnlineStatus = useCallback(
    (showOnlineStatus: boolean) => {
      updateSettings.mutate(
        { showOnlineStatus },
        {
          onError: () => {
            toast.error(t('settings.privacy.updateError'));
          },
        },
      );
    },
    [t, updateSettings],
  );

  return (
    <ThemedView className="flex-1">
      <Header
        options={{
          title: t('settings.privacy.title'),
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
        <SettingsListGroup
          footer={failed ? t('settings.privacy.loadError') : t('settings.privacy.description')}
        >
          <SettingsListItem
            icon={<Ionicons name="lock-closed" size={20} color={theme.colors.text} />}
            title={t('settings.privacy.privateProfile')}
            value={t(profileVisibilityLabelKey(settings.profileVisibility))}
            onPress={() => router.push('/settings/privacy/profile-visibility')}
          />
          <SettingsListItem
            icon={<Ionicons name="ellipse" size={20} color={theme.colors.text} />}
            title={t('settings.privacy.showOnlineStatus')}
            description={t('settings.privacy.showOnlineStatusDesc')}
            showChevron={false}
            rightElement={
              <Switch
                value={settings.showOnlineStatus}
                onValueChange={onToggleOnlineStatus}
                // Until the stored value has arrived the switch is showing the
                // schema default, not the reader's choice. Writing from that
                // position would save a setting they never made.
                disabled={!saved}
                testID="online-status-switch"
              />
            }
          />
          <SettingsListItem
            icon={<Ionicons name="people" size={20} color={theme.colors.text} />}
            title={t('settings.privacy.restrictedProfiles')}
            onPress={() => router.push('/settings/privacy/restricted')}
          />
          <SettingsListItem
            icon={<Ionicons name="close-circle" size={20} color={theme.colors.text} />}
            title={t('settings.privacy.blockedProfiles')}
            onPress={() => router.push('/settings/privacy/blocked')}
          />
          <SettingsListItem
            icon={<Ionicons name="eye-off" size={20} color={theme.colors.text} />}
            title={t('settings.privacy.hiddenWords')}
            onPress={() => router.push('/settings/privacy/hidden-words')}
          />
        </SettingsListGroup>
      </ScrollView>
    </ThemedView>
  );
}
