import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { useAlloSettings } from '../context';

import {
  Button as LButton,
  GroupedSection as LGroupedSection,
  GroupedSectionItem as LGroupedSectionItem,
  SettingsSection as LSettingsSection,
  Text,
  toElement,
} from '@oxy.so/bloom-language';

/**
 * The UI language is an Oxy-account concern, not Allo's: Oxy resolves it
 * (account locales when signed in, the device's otherwise) and ships the picker
 * that reads and writes it, so this screen shows the current choice and opens
 * that shared sheet.
 */
export default function LanguageSettingsScreen() {
  const { t } = useTranslation();
  const settings = useAlloSettings();
  const { showBottomSheet, currentLanguage, currentLanguages } = useOxy();

  // The same fallback `LanguageSelectorScreen` uses: account locales, else the resolved one.
  const selected = currentLanguages.length > 0 ? currentLanguages : [currentLanguage];

  return toElement(
    LSettingsSection(
      t('settings.language.selectLanguage'),
      LGroupedSection(
        LGroupedSectionItem(t('settings.preferences.language'))
          .lines(0)
          .descriptionLines(0)
          .wrapControl()
          .description(selected.map((code) => getNativeLanguageName(code)).join(', '))
          .trailing(
            LButton(Text(t('common.open')))
              .onPress(() => settings.close(() => showBottomSheet?.('LanguageSelector')))
              .label(t('settings.preferences.language'))
              .tint('neutral')
              .style('outline'),
          ),
      ),
    ),
  );
}
