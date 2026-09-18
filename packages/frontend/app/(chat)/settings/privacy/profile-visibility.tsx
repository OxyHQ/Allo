import React, { useCallback } from 'react';
import { ActivityIndicator } from 'react-native';
import { useTranslation } from 'react-i18next';
import { RiCheckboxCircleFill } from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';

import { Page } from '@/components/shell/Page';
import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';
import { PROFILE_VISIBILITIES, type ProfileVisibility } from '@/lib/privacy/api';
import { profileVisibilityDescriptionKey, profileVisibilityLabelKey } from '@/lib/privacy/labels';

/**
 * WHO MAY SEE THIS PROFILE — one of three, with a tick beside the current one.
 *
 * The values come from `PROFILE_VISIBILITIES` rather than being listed again
 * here, so a change to what the backend accepts shows up as a row rather than
 * as a silently missing option.
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
          onSuccess: () => toast.success(t('settings.privacy.profileVisibilityUpdated')),
          onError: () => toast.error(t('settings.privacy.updateError')),
        },
      );
    },
    [settings.profileVisibility, t, updateSettings],
  );

  return (
    <Page title={t('settings.privacy.privateProfile')}>
      <SettingsListGroup footer={t('settings.privacy.description')}>
        {PROFILE_VISIBILITIES.map((visibility) => {
          const saving = updateSettings.isPending && updateSettings.variables?.profileVisibility === visibility;
          return (
            <SettingsListItem
              key={visibility}
              title={t(profileVisibilityLabelKey(visibility))}
              description={t(profileVisibilityDescriptionKey(visibility))}
              onPress={() => choose(visibility)}
              // Until the stored value arrives every row is drawn against the
              // schema default, not the reader's own setting.
              disabled={!saved || updateSettings.isPending}
              showChevron={false}
              rightElement={
                saving ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : settings.profileVisibility === visibility ? (
                  <RiCheckboxCircleFill width={22} height={22} fill={theme.colors.primary} />
                ) : null
              }
            />
          );
        })}
      </SettingsListGroup>
    </Page>
  );
}
