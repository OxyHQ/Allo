import { SegmentedControl, SegmentedControlItem, SegmentedControlItemText } from '@oxy.so/bloom/segmented-control';
import { Select, SelectContent, SelectItem, SelectItemIndicator, SelectItemText, SelectTrigger, SelectValue } from '@oxy.so/bloom/select';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY, FREE_COLOR_NAMES, type AppColorName } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { colorPresetFromSetting, THEME_MODES, themeModeFromSetting } from '@/lib/theme';
import { useAppearanceStore, type AppearanceSettings } from '@/stores/appearanceStore';

type Mode = (typeof THEME_MODES)[number];

const MODE_LABELS: Record<Mode, string> = {
  system: 'settings.appearance.mode.system',
  light: 'settings.appearance.mode.light',
  dark: 'settings.appearance.mode.dark',
};

const FREE = new Set<AppColorName>(FREE_COLOR_NAMES);
const PRESETS = COLOR_PRESET_REGISTRY.filter((preset) => FREE.has(preset.name));

/**
 * Light, dark or the system's, and a colour preset. Both live in the account's
 * appearance settings, which `BloomProvider` reads, so a choice re-themes the
 * app as soon as the store has it and follows the account to other devices.
 */
export default function AppearanceSettingsScreen() {
  const { t } = useTranslation();
  const appearance = useAppearanceStore((state) => state.mySettings?.appearance);
  const mode = themeModeFromSetting(appearance?.themeMode) as Mode;
  const preset = colorPresetFromSetting(appearance?.colorTheme);
  const current = PRESETS.find((entry) => entry.name === preset);

  const save = useCallback(
    async (next: Partial<AppearanceSettings>) => {
      const store = useAppearanceStore.getState();
      // The store applies it optimistically and puts the old value back on failure.
      const saved = await store.updateMySettings({
        appearance: { themeMode: mode, colorTheme: preset, ...next },
      });
      if (!saved && useAppearanceStore.getState().error) toast.error(t('settings.appearance.saveError'));
    },
    [mode, preset, t],
  );

  return (
    <SettingsGeneralPage
      sections={[
        {
          key: 'theme',
          rows: [
            {
              key: 'mode',
              label: t('settings.appearance.theme'),
              control: (
                <SegmentedControl
                  label={t('settings.appearance.theme')}
                  type="radio"
                  value={mode}
                  onChange={(value) => void save({ themeMode: value as Mode })}
                >
                  {THEME_MODES.map((value) => (
                    <SegmentedControlItem key={value} value={value}>
                      <SegmentedControlItemText>{t(MODE_LABELS[value])}</SegmentedControlItemText>
                    </SegmentedControlItem>
                  ))}
                </SegmentedControl>
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
              control: (
                <Select value={preset} onValueChange={(value) => void save({ colorTheme: value as AppColorName })}>
                  <SelectTrigger label={t('settings.appearance.color')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    label={t('settings.appearance.color')}
                    items={PRESETS.map((entry) => ({
                      value: entry.name,
                      label: entry.displayName,
                    }))}
                    renderItem={(item) => (
                      <SelectItem value={item.value} label={item.label}>
                        <SelectItemText>{item.label}</SelectItemText>
                        <SelectItemIndicator />
                      </SelectItem>
                    )}
                  />
                </Select>
              ),
            },
          ],
        },
      ]}
    />
  );
}
