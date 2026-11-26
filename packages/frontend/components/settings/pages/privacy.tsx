import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useAlloSettings } from '../context';

import { useMyPrivacySettings, useUpdatePrivacySettings } from '@/hooks/usePrivacySettings';

import {
  Button as LButton,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Text,
  Toggle,
  toElement,
} from '@oxy.so/bloom-language';

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

  return toElement(
    LSettingsSection(
      undefined,
      LGroupedSection(
        LGroupedSectionItem(t('settings.privacy.showOnlineStatus'))
          .lines(0)
          .descriptionLines(0)
          .wrapControl()
          .description(t('settings.privacy.showOnlineStatusDesc'))
          .trailing(
            Toggle([settings.showOnlineStatus, onToggleOnlineStatus])
              .disabled(!saved)
              .label(t('settings.privacy.showOnlineStatus'))
              .testID('online-status-switch'),
          ),
        LGroupedSectionItem(t('settings.privacy.blockedProfiles'))
          .lines(0)
          .descriptionLines(0)
          .wrapControl()
          .trailing(
            LButton(Text(t('common.open')))
              .onPress(() => settingsModal.open('privacy-blocked'))
              .label(t('settings.privacy.blockedProfiles'))
              .tint('neutral')
              .style('outline'),
          ),
      ),
    ).description(failed ? t('settings.privacy.loadError') : t('settings.privacy.description')),
  );
}
