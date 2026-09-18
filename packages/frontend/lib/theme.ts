/**
 * The app's theme is Bloom's, and nothing else.
 *
 * Mode and colour preset are the two choices a person makes; both live in the
 * appearance settings (`stores/appearanceStore.ts`), which follow the account
 * across devices, and are handed to `BloomProvider` as controlled props. Every
 * colour a screen paints comes from `useTheme()` in `@oxy.so/bloom/theme`.
 */
import { APP_COLOR_NAMES, type AppColorName, type ThemeMode } from '@oxy.so/bloom/theme';

/** Allo's own green. */
export const DEFAULT_COLOR_PRESET: AppColorName = 'green';

export const THEME_MODES = ['system', 'light', 'dark'] as const satisfies readonly ThemeMode[];

const PRESETS = new Set<string>(APP_COLOR_NAMES);

/**
 * A stored preset name as one Bloom knows. Settings written by an older build
 * carry names from a theme list that no longer exists (`classic`, `day`), and
 * those draw the default rather than failing.
 */
export function colorPresetFromSetting(name: string | undefined): AppColorName {
  return name && PRESETS.has(name) ? (name as AppColorName) : DEFAULT_COLOR_PRESET;
}

export function themeModeFromSetting(mode: string | undefined): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(mode ?? '') ? (mode as ThemeMode) : 'system';
}
