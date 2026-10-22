import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectItemIndicator,
  SelectItemText,
  SelectTrigger,
  SelectValue,
} from '@oxy.so/bloom/select';
import { SettingsGeneralPage } from '@oxy.so/bloom/settings-modal';
import { COLOR_PRESET_REGISTRY } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { useAccountColorSave } from '@oxy.so/services/ui/client';
import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';

import { THEME_MODES, themeModeFromSetting } from '@/lib/theme';
import { useAppearanceStore, type AppearanceSettings } from '@/stores/appearanceStore';

type Mode = (typeof THEME_MODES)[number];

const MODE_LABELS: Record<Mode, string> = {
  system: 'settings.appearance.mode.system',
  light: 'settings.appearance.mode.light',
  dark: 'settings.appearance.mode.dark',
};

/**
 * Light, dark or the system's, and the account colour. The mode lives in the
 * account's appearance settings, which `BloomProvider` reads; the colour is the
 * Oxy account's, shared by every Oxy app, and Oxy decides which ones it may wear.
 */
export default function AppearanceSettingsScreen() {
  const { t } = useTranslation();
  const appearance = useAppearanceStore((state) => state.mySettings?.appearance);
  const mode = themeModeFromSetting(appearance?.themeMode) as Mode;
  const { colors, value, saveColor } = useAccountColorSave();
  const presets = COLOR_PRESET_REGISTRY.filter((entry) => colors.includes(entry.name));
  const current = presets.find((entry) => entry.name === value);

  const save = useCallback(
    async (next: Partial<AppearanceSettings>) => {
      const store = useAppearanceStore.getState();
      // The store applies it optimistically and puts the old value back on failure.
      const saved = await store.updateMySettings({
        appearance: { themeMode: mode, ...next },
      });
      if (!saved && useAppearanceStore.getState().error)
        toast.error(t('settings.appearance.saveError'));
    },
    [mode, t],
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
                <Select
                  value={value}
                  onValueChange={(next) =>
                    saveColor(next as typeof value).catch(() =>
                      toast.error(t('settings.appearance.colorSaveError')),
                    )
                  }
                >
                  <SelectTrigger label={t('settings.appearance.color')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    label={t('settings.appearance.color')}
                    items={presets.map((entry) => ({
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
