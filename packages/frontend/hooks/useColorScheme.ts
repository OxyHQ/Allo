import { useColorScheme as useRNColorScheme } from 'react-native';
import { useAppearanceStore } from '@/stores/appearanceStore';

// Returns 'light' or 'dark' based on user preference; falls back to OS setting
export function useColorScheme(): 'light' | 'dark' {
	const rnScheme = useRNColorScheme();
	// Use selector to only subscribe to mySettings, not the entire store
	const mySettings = useAppearanceStore((state) => state.mySettings);
	const pref = mySettings?.appearance?.themeMode ?? 'system';

	if (pref === 'light' || pref === 'dark') return pref;
	// RN's ColorSchemeName can be 'light' | 'dark' | 'unspecified' (and
	// null/undefined). Normalize anything that isn't an explicit 'dark' to
	// 'light' to preserve the existing default.
	return rnScheme === 'dark' ? 'dark' : 'light';
}
