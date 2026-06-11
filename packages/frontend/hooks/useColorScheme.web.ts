import { useEffect, useState } from 'react';
import { useColorScheme as useRNColorScheme } from 'react-native';
import { useAppearanceStore } from '@/stores/appearanceStore';

/**
 * To support static rendering, this value needs to be re-calculated on the client side for web
 */
export function useColorScheme(): 'light' | 'dark' {
  const [hasHydrated, setHasHydrated] = useState(false);

  useEffect(() => {
    setHasHydrated(true);
  }, []);

  const colorScheme = useRNColorScheme();
  // Use selector to only subscribe to mySettings
  const mySettings = useAppearanceStore((state) => state.mySettings);
  const pref = mySettings?.appearance?.themeMode ?? 'system';

  if (hasHydrated) {
    if (pref === 'light' || pref === 'dark') return pref;
    // RN's ColorSchemeName can be 'light' | 'dark' | 'unspecified' (and
    // null/undefined). Normalize anything that isn't an explicit 'dark' to
    // 'light' to preserve the existing default.
    return colorScheme === 'dark' ? 'dark' : 'light';
  }

  // During SSR/first render, default to light for consistent static HTML
  return (pref === 'light' || pref === 'dark') ? pref : 'light';
}
