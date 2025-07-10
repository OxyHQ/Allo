import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import { Appearance } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeContextType {
    themeMode: ThemeMode;
    isDarkMode: boolean;
    setThemeMode: (mode: ThemeMode) => void;
}

const ThemeContext = createContext<ThemeContextType | undefined>(undefined);

const THEME_STORAGE_KEY = '@theme_mode';

export function ThemeProvider({ children }: { children: ReactNode }) {
    const [themeMode, setThemeModeState] = useState<ThemeMode>('system');
    const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(
        Appearance.getColorScheme() || 'light'
    );

    // Calculate if we should use dark mode
    const isDarkMode = themeMode === 'dark' || (themeMode === 'system' && systemTheme === 'dark');

    // Listen to system theme changes
    useEffect(() => {
        const subscription = Appearance.addChangeListener(({ colorScheme }) => {
            setSystemTheme(colorScheme || 'light');
        });
        return () => subscription.remove();
    }, []);

    // Load saved theme preference
    useEffect(() => {
        loadThemePreference();
    }, []);

    const loadThemePreference = async () => {
        try {
            const savedTheme = await AsyncStorage.getItem(THEME_STORAGE_KEY);
            if (savedTheme && ['system', 'light', 'dark'].includes(savedTheme)) {
                setThemeModeState(savedTheme as ThemeMode);
            }
        } catch (error) {
            console.error('Failed to load theme preference:', error);
        }
    };

    const setThemeMode = async (mode: ThemeMode) => {
        try {
            setThemeModeState(mode);
            await AsyncStorage.setItem(THEME_STORAGE_KEY, mode);
        } catch (error) {
            console.error('Failed to save theme preference:', error);
        }
    };

    return (
        <ThemeContext.Provider value={{ themeMode, isDarkMode, setThemeMode }}>
            {children}
        </ThemeContext.Provider>
    );
}

export function useTheme() {
    const context = useContext(ThemeContext);
    if (context === undefined) {
        throw new Error('useTheme must be used within a ThemeProvider');
    }
    return context;
} 