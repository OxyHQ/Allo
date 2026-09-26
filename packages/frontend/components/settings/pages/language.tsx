import { Button } from '@oxy.so/bloom/button';
import { SettingsCard, SettingsRow, SettingsSection } from '@oxy.so/bloom/settings-modal';
import { getNativeLanguageName } from '@oxy.so/core';
import { useOxy } from '@oxy.so/services';
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
    <>
      <SettingsSection label={t('settings.language.selectLanguage')}>
        <SettingsCard>
          <SettingsRow
            label={t('settings.preferences.language')}
            description={selected.map((code) => getNativeLanguageName(code)).join(', ')}
          >
            <Button
              variant="secondary"
              onPress={() => settings.close(() => showBottomSheet?.('LanguageSelector'))}
              accessibilityLabel={t('settings.preferences.language')}
            >
              {t('common.open')}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
