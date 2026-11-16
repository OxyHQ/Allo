import { GroupedSection, GroupedSectionItem } from '@oxy.so/bloom/grouped-section';
import { Button } from '@oxy.so/bloom/button';
import { SettingsSection } from '@oxy.so/bloom/settings-modal';
import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { useAlloSettings } from '../context';

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

  return (
    <SettingsSection label={t('settings.language.selectLanguage')}>
      <GroupedSection>
        <GroupedSectionItem
          titleNumberOfLines={0}
          descriptionLines={0}
          wrapControl
          title={t('settings.preferences.language')}
          description={selected.map((code) => getNativeLanguageName(code)).join(', ')}
          rightElement={
            <Button
              onPress={() => settings.close(() => showBottomSheet?.('LanguageSelector'))}
              accessibilityLabel={t('settings.preferences.language')}
              tone="neutral"
              appearance="outline"
            >
              {t('common.open')}
            </Button>
          }
        />
      </GroupedSection>
    </SettingsSection>
  );
}
