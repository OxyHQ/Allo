import { Button } from '@oxy.so/bloom/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlloSettings } from '../context';

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
 * Presence is enforced by the messaging presence layer. Restrictions and hidden
 * words retain their explicit limits in the account descriptions.
 */
export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const settingsModal = useAlloSettings();
  const { settings, saved, failed } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const onToggleOnlineStatus = useCallback(
    (showOnlineStatus: boolean) => {
      updateSettings.mutate({ showOnlineStatus }, { onError: () => toast.error(t('settings.privacy.updateError')) });
    },
    [t, updateSettings],
  );

  return (
    <>
      <SettingsSection description={failed ? t('settings.privacy.loadError') : t('settings.privacy.description')}>
        <SettingsCard>
          <SettingsRow label={t('settings.privacy.privateProfile')}>
            <Button
              variant="secondary"
              onPress={() => settingsModal.open('privacy-profile-visibility')}
              accessibilityLabel={t('settings.privacy.privateProfile')}
            >
              {t(profileVisibilityLabelKey(settings.profileVisibility))}
            </Button>
          </SettingsRow>
          <SettingsRow label={t('settings.privacy.showOnlineStatus')} description={t('settings.privacy.showOnlineStatusDesc')}>
            {
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
          </SettingsRow>
          <SettingsRow label={t('settings.privacy.restrictedProfiles')}>
            <Button
              variant="secondary"
              onPress={() => settingsModal.open('privacy-restricted')}
              accessibilityLabel={t('settings.privacy.restrictedProfiles')}
            >
              {t('common.open')}
            </Button>
          </SettingsRow>
          <SettingsRow label={t('settings.privacy.blockedProfiles')}>
            <Button
              variant="secondary"
              onPress={() => settingsModal.open('privacy-blocked')}
              accessibilityLabel={t('settings.privacy.blockedProfiles')}
            >
              {t('common.open')}
            </Button>
          </SettingsRow>
          <SettingsRow label={t('settings.privacy.hiddenWords')}>
            <Button
              variant="secondary"
              onPress={() => settingsModal.open('privacy-hidden-words')}
              accessibilityLabel={t('settings.privacy.hiddenWords')}
            >
              {t('common.open')}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
