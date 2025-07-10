import { MD3LightTheme, MD3DarkTheme } from 'react-native-paper';
import { colors } from './theme';

// Light theme configuration
export const lightTheme = {
  ...MD3LightTheme,
  colors: {
    ...MD3LightTheme.colors,
    // Primary colors (Allo green)
    primary: colors.alloGreen,
    primaryContainer: colors.alloGreenLight,
    onPrimary: colors.white,
    onPrimaryContainer: colors.white,

    // Secondary colors (Accent blue)
    secondary: colors.accentBlue,
    secondaryContainer: colors.neutral100,
    onSecondary: colors.white,
    onSecondaryContainer: colors.textDark,

    // Tertiary colors (Dark green)
    tertiary: colors.alloGreenDark,
    tertiaryContainer: colors.surfaceLight,
    onTertiary: colors.white,
    onTertiaryContainer: colors.textDark,

    // Error colors
    error: colors.rose,
    errorContainer: "#fef2f2",
    onError: colors.white,
    onErrorContainer: colors.rose,

    // Background and surface
    background: colors.white,
    onBackground: colors.textDark,
    surface: colors.white,
    onSurface: colors.textDark,
    surfaceVariant: colors.neutral100,
    onSurfaceVariant: colors.timestampText,

    // Outline and borders
    outline: colors.neutral200,
    outlineVariant: colors.neutral100,

    // Shadow and scrim
    shadow: colors.black,
    scrim: colors.black,

    // Inverse colors
    inverseSurface: colors.neutral800,
    inverseOnSurface: colors.white,
    inversePrimary: colors.alloGreenLight,

    // Elevation levels
    elevation: {
      level0: "transparent",
      level1: colors.white,
      level2: colors.neutral50,
      level3: colors.neutral100,
      level4: colors.neutral100,
      level5: colors.neutral200,
    },

    // Disabled states
    surfaceDisabled: colors.neutral100,
    onSurfaceDisabled: colors.neutral400,
    backdrop: "rgba(0, 0, 0, 0.5)",
  },
  roundness: 12,
};

// Dark theme configuration
export const darkTheme = {
  ...MD3DarkTheme,
  colors: {
    ...MD3DarkTheme.colors,
    // Primary colors (Allo green - adjusted for dark mode)
    primary: colors.alloGreenLight,
    primaryContainer: colors.alloGreenDark,
    onPrimary: colors.black,
    onPrimaryContainer: colors.white,

    // Secondary colors (Accent blue - adjusted for dark mode)
    secondary: colors.accentBlue,
    secondaryContainer: colors.neutral700,
    onSecondary: colors.black,
    onSecondaryContainer: colors.white,

    // Tertiary colors
    tertiary: colors.alloGreen,
    tertiaryContainer: colors.neutral800,
    onTertiary: colors.white,
    onTertiaryContainer: colors.white,

    // Error colors
    error: "#ef4444",
    errorContainer: "#7f1d1d",
    onError: colors.white,
    onErrorContainer: "#fca5a5",

    // Background and surface
    background: colors.neutral900,
    onBackground: colors.white,
    surface: colors.neutral800,
    onSurface: colors.white,
    surfaceVariant: colors.neutral700,
    onSurfaceVariant: colors.neutral300,

    // Outline and borders
    outline: colors.neutral500,
    outlineVariant: colors.neutral600,

    // Shadow and scrim
    shadow: colors.black,
    scrim: colors.black,

    // Inverse colors
    inverseSurface: colors.neutral100,
    inverseOnSurface: colors.neutral800,
    inversePrimary: colors.alloGreen,

    // Elevation levels (darker surfaces for dark mode)
    elevation: {
      level0: "transparent",
      level1: colors.neutral800,
      level2: colors.neutral700,
      level3: colors.neutral600,
      level4: colors.neutral500,
      level5: colors.neutral400,
    },

    // Disabled states
    surfaceDisabled: colors.neutral700,
    onSurfaceDisabled: colors.neutral500,
    backdrop: "rgba(0, 0, 0, 0.7)",
  },
  roundness: 12,
};

// Function to get theme based on isDarkMode
export function getTheme(isDarkMode: boolean) {
  return isDarkMode ? darkTheme : lightTheme;
} 