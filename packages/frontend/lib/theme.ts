/**
 * The app's theme is Bloom's, and nothing else.
 *
 * Bloom keeps the last mode and colour on this device (`THEME_PERSIST_KEY`), so
 * a cold start paints them at once. The Oxy account's portable theme (its
 * colour always, its mode while this device follows the account) is applied on
 * top by the SDK's `useAccountTheme`. Every colour a screen paints comes from
 * `useTheme()` in `@oxy.so/bloom/theme`.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  webLocalStorage,
  type AppColorName,
  type BloomThemeStorage,
  type ThemeMode,
} from '@oxy.so/bloom/theme';
import { Platform } from 'react-native';

/** Allo's own green: what a signed-out visitor sees. */
export const DEFAULT_COLOR_PRESET: AppColorName = 'green';

export const THEME_MODES = ['system', 'light', 'dark'] as const satisfies readonly ThemeMode[];

/** Where Bloom keeps this device's theme between launches. */
export const THEME_PERSIST_KEY = 'allo.bloom.theme';

/**
 * Bloom's theme storage: `localStorage` on web, read synchronously so the first
 * paint already has the theme (and absent while the web export renders pages
 * on the server, where there is no storage); AsyncStorage on native, whose
 * methods already have Bloom's shape.
 */
export const THEME_STORAGE: BloomThemeStorage | undefined =
  Platform.OS === 'web' ? webLocalStorage : AsyncStorage;
