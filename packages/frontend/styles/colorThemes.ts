export interface ColorThemeVariant {
  bubbleSent: string;
  bubbleReceived: string;
  textSent: string;
  textReceived: string;
  background: string;
}

export interface ColorTheme {
  id: string;
  label: string;
  primaryColor: string;
  light: ColorThemeVariant;
  dark: ColorThemeVariant;
}

// Color themes: each supports both light and dark modes
export const COLOR_THEMES: ColorTheme[] = [
  {
    id: 'classic',
    label: 'Classic',
    primaryColor: '#21C063',
    light: {
      bubbleSent: '#21C063',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#E5DDD5',
    },
    dark: {
      bubbleSent: '#21C063',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D0D1A',
    },
  },
  {
    id: 'day',
    label: 'Day',
    primaryColor: '#1D9BF0',
    light: {
      bubbleSent: '#1D9BF0',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#C8DCF0',
    },
    dark: {
      bubbleSent: '#1D9BF0',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D1A24',
    },
  },
  {
    id: 'purple',
    label: 'Purple',
    primaryColor: '#8B5CF6',
    light: {
      bubbleSent: '#8B5CF6',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#E9D5FF',
    },
    dark: {
      bubbleSent: '#8B5CF6',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0D0D1A',
    },
  },
  {
    id: 'teal',
    label: 'Teal',
    primaryColor: '#005c67',
    light: {
      bubbleSent: '#005c67',
      bubbleReceived: '#FFFFFF',
      textSent: '#FFFFFF',
      textReceived: '#000000',
      background: '#B2D8D8',
    },
    dark: {
      bubbleSent: '#005c67',
      bubbleReceived: '#1E1E2E',
      textSent: '#FFFFFF',
      textReceived: '#E0E0E0',
      background: '#0A1414',
    },
  },
];

export function getColorTheme(themeId: string): ColorTheme {
  return COLOR_THEMES.find((t) => t.id === themeId) || COLOR_THEMES[0];
}
