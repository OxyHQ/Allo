import React, { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { RiEyeOffLine, RiForbidLine, RiLockLine, RiPulseLine, RiUserMinusLine } from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { Switch } from '@oxy.so/bloom/switch';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { profileVisibilityLabelKey } from '@/lib/privacy/labels';

/**
 * WHAT ALLO CAN HONESTLY OFFER UNDER "PRIVACY".
 *
 * Five rows, shaped by what each one is: online status is ONE boolean, so it is
 * a switch here in the list; profile visibility is a choice of three, so it is
 * a chooser screen; blocked, restricted and hidden words are LISTS, each a
 * screen that can show, add and remove. Mention's feed fields that ride along
 * in the stored document (`allowTags`, `hide*Counts`) are named nowhere: Allo
 * has nothing for them to govern.
 *
 * Nothing acts on these settings yet, and the footer says so rather than
 * implying protection.
 */
export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const router = useRouter();
  const { settings, saved, failed } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();
  const iconProps = { width: 20, height: 20, fill: theme.colors.textSecondary };

  const onToggleOnlineStatus = useCallback(
    (showOnlineStatus: boolean) => {
      updateSettings.mutate({ showOnlineStatus }, { onError: () => toast.error(t('settings.privacy.updateError')) });
    },
    [t, updateSettings],
  );

  return (
    <Page title={t('settings.privacy.title')}>
      <SettingsListGroup footer={failed ? t('settings.privacy.loadError') : t('settings.privacy.description')}>
        <SettingsListItem
          icon={<RiLockLine {...iconProps} />}
          title={t('settings.privacy.privateProfile')}
          value={t(profileVisibilityLabelKey(settings.profileVisibility))}
          onPress={() => router.push('/settings/privacy/profile-visibility')}
        />
        <SettingsListItem
          icon={<RiPulseLine {...iconProps} />}
          title={t('settings.privacy.showOnlineStatus')}
          description={t('settings.privacy.showOnlineStatusDesc')}
          showChevron={false}
          rightElement={
            <Switch
              value={settings.showOnlineStatus}
              onValueChange={onToggleOnlineStatus}
              // Until the stored value arrives the switch shows the schema
              // default; writing from there would save a choice never made.
              disabled={!saved}
              accessibilityLabel={t('settings.privacy.showOnlineStatus')}
              testID="online-status-switch"
            />
          }
        />
        <SettingsListItem
          icon={<RiUserMinusLine {...iconProps} />}
          title={t('settings.privacy.restrictedProfiles')}
          onPress={() => router.push('/settings/privacy/restricted')}
        />
        <SettingsListItem
          icon={<RiForbidLine {...iconProps} />}
          title={t('settings.privacy.blockedProfiles')}
          onPress={() => router.push('/settings/privacy/blocked')}
        />
        <SettingsListItem
          icon={<RiEyeOffLine {...iconProps} />}
          title={t('settings.privacy.hiddenWords')}
          onPress={() => router.push('/settings/privacy/hidden-words')}
        />
      </SettingsListGroup>
    </Page>
  );
}
