import React, { useCallback } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import {
  SegmentedControl,
  SegmentedControlItem,
  SegmentedControlItemText,
} from '@oxy.so/bloom/segmented-control';
import { SettingsListGroup } from '@oxy.so/bloom/settings-list';
import { COLOR_PRESET_REGISTRY, FREE_COLOR_NAMES, useTheme, type AppColorName } from '@oxy.so/bloom/theme';
import { toast } from '@oxy.so/bloom/toast';
import { Muted, Text } from '@oxy.so/bloom/typography';

import { Page } from '@/components/shell/Page';
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
  const theme = useTheme();
  const appearance = useAppearanceStore((state) => state.mySettings?.appearance);
  const mode = themeModeFromSetting(appearance?.themeMode) as Mode;
  const preset = colorPresetFromSetting(appearance?.colorTheme);
  const current = PRESETS.find((entry) => entry.name === preset);

  const save = useCallback(
    async (next: Partial<AppearanceSettings>) => {
      const store = useAppearanceStore.getState();
      // The store applies it optimistically and puts the old value back on failure.
      const saved = await store.updateMySettings({ appearance: { themeMode: mode, colorTheme: preset, ...next } });
      if (!saved && useAppearanceStore.getState().error) toast.error(t('settings.appearance.saveError'));
    },
    [mode, preset, t],
  );

  return (
    <Page title={t('settings.preferences.appearance')}>
      <SettingsListGroup title={t('settings.appearance.theme')}>
        <View style={styles.section}>
          <SegmentedControl
            label={t('settings.appearance.theme')}
            type="radio"
            value={mode}
            onChange={(value) => void save({ themeMode: value as Mode })}
            style={styles.stretch}
          >
            {THEME_MODES.map((value) => (
              <SegmentedControlItem key={value} value={value}>
                <SegmentedControlItemText>{t(MODE_LABELS[value])}</SegmentedControlItemText>
              </SegmentedControlItem>
            ))}
          </SegmentedControl>
        </View>
      </SettingsListGroup>

      <SettingsListGroup title={t('settings.appearance.color')} footer={t('settings.appearance.syncNote')}>
        <View style={styles.section}>
          {current ? <Text style={[styles.presetName, { color: theme.colors.text }]}>{current.displayName}</Text> : null}
          <View style={styles.swatches} accessibilityRole="radiogroup" accessibilityLabel={t('settings.appearance.color')}>
            {PRESETS.map((entry) => {
              const selected = entry.name === preset;
              return (
                <Pressable
                  key={entry.name}
                  onPress={() => void save({ colorTheme: entry.name })}
                  accessibilityRole="radio"
                  accessibilityLabel={entry.displayName}
                  aria-checked={selected}
                  style={[styles.ring, { borderColor: selected ? theme.colors.text : 'transparent' }]}
                >
                  {/* The preset's own seed colour: data from Bloom, not a hardcoded paint. */}
                  <View style={[styles.swatch, { backgroundColor: entry.hex }]} />
                </Pressable>
              );
            })}
          </View>
          {current ? <Muted>{current.description}</Muted> : null}
        </View>
      </SettingsListGroup>
    </Page>
  );
}

const SWATCH = 32;

const styles = StyleSheet.create({
  section: { padding: 12, gap: 12 },
  stretch: { alignSelf: 'stretch' },
  presetName: { fontSize: 15, fontWeight: '500' },
  swatches: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  ring: {
    width: SWATCH + 8,
    height: SWATCH + 8,
    borderRadius: (SWATCH + 8) / 2,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  swatch: { width: SWATCH, height: SWATCH, borderRadius: SWATCH / 2 },
});
