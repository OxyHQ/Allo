/**
 * The app's theme is Bloom's, and nothing else.
 *
 * The mode lives in the appearance settings (`stores/appearanceStore.ts`), which
 * follow the account across devices, and is handed to `BloomProvider` as a
 * controlled prop. The colour is the Oxy account's (`useAccountColor`). Every
 * colour a screen paints comes from `useTheme()` in `@oxy.so/bloom/theme`.
 */
import { type AppColorName, type ThemeMode } from '@oxy.so/bloom/theme';

/** Allo's own green: what a signed-out visitor sees. */
export const DEFAULT_COLOR_PRESET: AppColorName = 'green';

export const THEME_MODES = ['system', 'light', 'dark'] as const satisfies readonly ThemeMode[];

export function themeModeFromSetting(mode: string | undefined): ThemeMode {
  return (THEME_MODES as readonly string[]).includes(mode ?? '') ? (mode as ThemeMode) : 'system';
}
