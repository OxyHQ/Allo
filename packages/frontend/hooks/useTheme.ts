import { useMemo } from "react";
import { useTheme as useBloomTheme } from "@oxyhq/bloom/theme";
import type { Theme as BloomTheme, ThemeColors as BloomThemeColors } from "@oxyhq/bloom/theme";
import { useAppearanceStore } from "@/stores/appearanceStore";
import { getColorTheme } from "@/styles/colorThemes";

/**
 * Centralized theme system — thin wrapper over `@oxyhq/bloom/theme`.
 *
 * Bloom provides the canonical palette (background, text, border, primary, …)
 * for the Oxy ecosystem; this hook augments Bloom's `ThemeColors` with the
 * Allo-specific chat surfaces (`messageBubble*`, `chatBackground`) that come
 * from the user-selected `colorTheme` in the appearance store.
 *
 * All other apps in the Oxy monorepo (Mention, Clarity, Homiio, …) use
 * `@oxyhq/bloom/theme` directly. Allo uses this hook so chat components keep
 * working unchanged, while everything else benefits from the shared palette
 * and dark-mode handling that Bloom owns.
 */

export interface ThemeColors extends BloomThemeColors {
  // Allo-specific chat surfaces
  messageBubbleSent: string;
  messageBubbleReceived: string;
  messageTextSent: string;
  messageTextReceived: string;
  chatBackground: string;
}

export interface Theme {
  mode: "light" | "dark";
  colors: ThemeColors;
  isDark: boolean;
  isLight: boolean;
}

/**
 * Main theme hook. Always use this (not raw Bloom hooks) inside Allo
 * components so chat-specific colors are available.
 */
export function useTheme(): Theme {
  const bloom: BloomTheme = useBloomTheme();
  const mySettings = useAppearanceStore((state) => state.mySettings);

  const selectedColorThemeId = mySettings?.appearance?.colorTheme || 'classic';
  const selectedColorTheme = getColorTheme(selectedColorThemeId);
  const themeVariant = bloom.isDark ? selectedColorTheme.dark : selectedColorTheme.light;

  const colors = useMemo<ThemeColors>(() => ({
    ...bloom.colors,
    messageBubbleSent: themeVariant.bubbleSent,
    messageBubbleReceived: themeVariant.bubbleReceived,
    messageTextSent: themeVariant.textSent,
    messageTextReceived: themeVariant.textReceived,
    chatBackground: themeVariant.chatBackground,
  }), [bloom.colors, themeVariant]);

  return {
    mode: bloom.mode,
    colors,
    isDark: bloom.isDark,
    isLight: bloom.isLight,
  };
}
