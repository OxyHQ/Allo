import React from 'react';
import { useTranslation } from 'react-i18next';
import { useOxy } from '@oxy.so/services';
import { getNativeLanguageName } from '@oxy.so/core';
import { RiTranslate2 } from '@oxy.so/bloom/icons';
import { SettingsListGroup, SettingsListItem } from '@oxy.so/bloom/settings-list';
import { useTheme } from '@oxy.so/bloom/theme';

import { Page } from '@/components/shell/Page';

/**
 * The UI language is an Oxy-account concern, not Allo's: Oxy resolves it
 * (account locales when signed in, the device's otherwise) and ships the picker
 * that reads and writes it, so this screen shows the current choice and opens
 * that shared sheet.
 */
export default function LanguageSettingsScreen() {
  const { t } = useTranslation();
  const theme = useTheme();
  const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();

  // The same fallback `LanguageSelectorScreen` uses: account locales, else the resolved one.
  const selected = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];

  return (
    <Page title={t('settings.preferences.language')}>
      <SettingsListGroup title={t('settings.language.selectLanguage')}>
        <SettingsListItem
          icon={<RiTranslate2 width={20} height={20} fill={theme.colors.textSecondary} />}
          title={t('settings.preferences.language')}
          description={selected.map((code) => getNativeLanguageName(code)).join(', ')}
          onPress={() => showBottomSheet?.('LanguageSelector')}
        />
      </SettingsListGroup>
    </Page>
  );
}
