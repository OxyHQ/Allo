import { Radio } from '@oxy.so/bloom/radio';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { useTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator } from 'react-native';

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
    <>
      <SettingsSection description={t('settings.privacy.description')}>
        <SettingsCard>
          {PROFILE_VISIBILITIES.map((visibility) => {
            const saving = updateSettings.isPending && updateSettings.variables?.profileVisibility === visibility;
            return (
              <SettingsRow
                key={visibility}
                label={t(profileVisibilityLabelKey(visibility))}
                description={t(profileVisibilityDescriptionKey(visibility))}
              >
                {saving ? (
                  <ActivityIndicator size="small" color={theme.colors.primary} />
                ) : (
                  <Radio
                    value={visibility}
                    checked={settings.profileVisibility === visibility}
                    onValueChange={choose}
                    disabled={!saved || updateSettings.isPending}
                    accessibilityLabel={t(profileVisibilityLabelKey(visibility))}
                  />
                )}
              </SettingsRow>
            );
          })}
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
