import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, useBloomTheme } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useAccountColorSave, useAccountThemeControls } from '@oxy.so/services/ui/client';
import { useTranslation } from 'react-i18next';
import { THEME_MODES } from '@/lib/theme';

import { toElement } from '@oxy.so/bloom-language';
import { Option, Segmented, Toggle } from '@oxy.so/bloom-language/inputs';
import { SettingsSelect as LSettingsSelect } from '@oxy.so/bloom-language/settings';

type Mode = (typeof THEME_MODES)[number];

const MODE_LABELS: Record<Mode, string> = {
  system: 'settings.appearance.mode.system',
  light: 'settings.appearance.mode.light',
  dark: 'settings.appearance.mode.dark',
};

/**
 * Light, dark or the system's, and the account colour. Both are the Oxy
 * account's theme, shared by every Oxy app: the colour always, the mode while
 * this device follows the account (the switch; off keeps the mode on this
 * device only). Oxy decides which colours the account may wear.
 */
export default function AppearanceSettingsScreen() {
  const { t } = useTranslation();
  const { mode: bloomMode } = useBloomTheme();
  const mode: Mode = bloomMode === 'light' || bloomMode === 'dark' ? bloomMode : 'system';
  const { source, changeThemeSource, changeThemeMode } = useAccountThemeControls();
  const { colors, value, saveColor } = useAccountColorSave();
  const presets = COLOR_PRESET_REGISTRY.filter((entry) => colors.includes(entry.name));
  const current = presets.find((entry) => entry.name === value);

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'theme',
          rows: [
            {
              key: 'sync',
              label: t('settings.appearance.followAccount'),
              description: t('settings.appearance.followAccountDescription'),
              control: toElement(
                Toggle([
                  source === 'account',
                  (on) => changeThemeSource(on ? 'account' : 'app'),
                ]).label(t('settings.appearance.followAccount')),
              ),
            },
            {
              key: 'mode',
              label: t('settings.appearance.theme'),
              control: toElement(
                Segmented(
                  [
                    mode,
                    (next) =>
                      changeThemeMode(next as Mode).catch(() =>
                        toast.error(t('settings.appearance.saveError')),
                      ),
                  ],
                  THEME_MODES.map((value) => Option(value, t(MODE_LABELS[value]))),
                ).label(t('settings.appearance.theme')),
              ),
            },
          ],
        },
        {
          key: 'color',
          description: t('settings.appearance.syncNote'),
          rows: [
            {
              key: 'preset',
              label: t('settings.appearance.color'),
              description: current?.description,
              control: toElement(
                LSettingsSelect(
                  t('settings.appearance.color'),
                  [
                    value,
                    (next) =>
                      saveColor(next).catch(() =>
                        toast.error(t('settings.appearance.colorSaveError')),
                      ),
                  ],
                  presets.map((entry) => ({
                    value: entry.name,
                    label: entry.displayName,
                  })),
                ),
              ),
            },
          ],
        },
      ]}
    />
  );
}
