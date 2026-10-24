import { Button } from '@oxy.so/bloom/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { Switch } from '@oxy.so/bloom/switch';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlloSettings } from '../context';

import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';

/**
 * THE TWO PRIVACY SETTINGS ALLO ENFORCES, and nothing else.
 *
 * Online status is ONE boolean, so it is a switch here in the list; blocked
 * profiles is a LIST, a screen that can show, add and remove. Both are acted on
 * by the server: the presence layer honours `showOnlineStatus` (and an account
 * that hides its own sees nobody else's), and a block stops new direct
 * messages, invitations and presence in both directions.
 *
 * Every other field the stored document carries (Mention's `allowTags` and
 * `hide*Counts`, and the profile visibility, hidden words and restricted list
 * Allo once showed) is named nowhere: nothing in Allo acts on it, and a row
 * for it would be a promise the app does not keep.
 */
export default function PrivacySettingsScreen() {
  const { t } = useTranslation();
  const settingsModal = useAlloSettings();
  const { settings, saved, failed } = useMyPrivacySettings();
  const updateSettings = useUpdatePrivacySettings();

  const onToggleOnlineStatus = useCallback(
    (showOnlineStatus: boolean) => {
      updateSettings.mutate(
        { showOnlineStatus },
        { onError: () => toast.error(t('settings.privacy.updateError')) },
      );
    },
    [t, updateSettings],
  );

  return (
    <>
      <SettingsSection
        description={failed ? t('settings.privacy.loadError') : t('settings.privacy.description')}
      >
        <SettingsCard>
          <SettingsRow
            label={t('settings.privacy.showOnlineStatus')}
            description={t('settings.privacy.showOnlineStatusDesc')}
          >
            {
              <Switch
                checked={settings.showOnlineStatus}
                onCheckedChange={onToggleOnlineStatus}
                // Until the stored value arrives the switch shows the schema
                // default; writing from there would save a choice never made.
                disabled={!saved}
                accessibilityLabel={t('settings.privacy.showOnlineStatus')}
                testID="online-status-switch"
              />
            }
          </SettingsRow>
          <SettingsRow label={t('settings.privacy.blockedProfiles')}>
            <Button
              onPress={() => settingsModal.open('privacy-blocked')}
              accessibilityLabel={t('settings.privacy.blockedProfiles')}
              tone="neutral"
              appearance="outline"
            >
              {t('common.open')}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
