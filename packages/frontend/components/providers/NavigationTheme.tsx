import { useMemo, type ReactNode } from 'react';
import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { useTheme } from '@oxy.so/bloom/theme';

/** Expo's navigator uses its own theme; scene paint must follow the owning Bloom surface. */
export function NavigationTheme({ children, transparent = false }: { children: ReactNode; transparent?: boolean }) {
  const { colors, isDark } = useTheme();
  const value = useMemo(
    () => ({
      ...(isDark ? DarkTheme : DefaultTheme),
      colors: {
        ...(isDark ? DarkTheme.colors : DefaultTheme.colors),
        primary: colors.primary,
        background: transparent ? 'transparent' : colors.background,
        card: colors.backgroundSecondary,
        text: colors.text,
        border: colors.border,
        notification: colors.error,
      },
    }),
    [colors, isDark, transparent],
  );
  return <ThemeProvider value={value}>{children}</ThemeProvider>;
}
