// Guarantees globalThis.crypto.getRandomValues (expo-crypto-backed on RN) is
// installed before any crypto runs — `@allo/core`'s MLS engine draws every key
// and nonce from it.
import '@oxy.so/core';
// Required polyfill for @oxy.so/services - must be imported first
import 'react-native-url-polyfill/auto';
// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';
// Enable immer's MapSet plugin before any zustand/immer store produces a Set draft
import '@/lib/immerSetup';

import NetInfo from '@react-native-community/netinfo';
import { BloomProvider } from '@oxy.so/bloom/provider';
import { preventNativeSplashAutoHide, useHideNativeSplashWhenReady } from '@oxy.so/expo-splash';
import { useOxy } from '@oxy.so/services';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import React, { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/notifications/NotificationPermissionGate';
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { AlloRoot } from '@/lib/allo/AlloRoot';
import { AppInitializer } from '@/lib/appInitializer';
import { startConnectionMonitoring } from '@/lib/network/connectionStatus';
import { colorPresetFromSetting, themeModeFromSetting } from '@/lib/theme';
import { useAppearanceStore } from '@/stores/appearanceStore';

import '../styles/global.css';

// NATIVE ONLY: hold the OS splash until init has run; `useHideNativeSplashWhenReady`
// releases it. A no-op on web, where `AppSplashScreen` covers the same window.
preventNativeSplashAutoHide();

const IS_WEB = Platform.OS === 'web';

/** Bloom, driven by the account's appearance settings. */
function ThemeRoot({ children }: { children: ReactNode }) {
  const appearance = useAppearanceStore((state) => state.mySettings?.appearance);
  return (
    <BloomProvider
      fonts
      mode={themeModeFromSetting(appearance?.themeMode)}
      colorPreset={colorPresetFromSetting(appearance?.colorTheme)}
      // Web shows its own splash while fonts load; native is still behind the OS splash.
      onFontsLoading={IS_WEB ? <AppSplashScreen /> : null}
    >
      {children}
    </BloomProvider>
  );
}

/** Signed out, the chat group redirects to sign-in, and the other way round. */
function RootStack() {
  const { user } = useOxy();
  const signedIn = Boolean(user);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="(chat)" redirect={!signedIn} />
      <Stack.Screen name="(auth)" redirect={signedIn} />
      <Stack.Screen name="+not-found" />
    </Stack>
  );
}

/** Keeps React Query's online and focus state in step with the device. */
function useDeviceSignals() {
  useEffect(() => {
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });
    const stopMonitoring = startConnectionMonitoring();
    const appState = AppState.addEventListener('change', (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    });
    return () => {
      unsubscribeNetInfo();
      stopMonitoring();
      appState.remove();
    };
  }, []);
}

export default function RootLayout() {
  const [queryClient] = useState(() => new QueryClient(QUERY_CLIENT_CONFIG));
  const [initialized, setInitialized] = useState(false);
  // Web fades its splash out before the app appears; native has no such splash.
  const [splashFaded, setSplashFaded] = useState(!IS_WEB);
  const ready = initialized && splashFaded;

  useDeviceSignals();
  useHideNativeSplashWhenReady(ready);

  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => console.error('Failed to initialize i18n:', error));
    AppInitializer.initializeApp().finally(() => setInitialized(true));
  }, []);

  useEffect(() => {
    if (ready) void AppInitializer.initializeDeferred();
  }, [ready]);

  return (
    <ThemeRoot>
      {ready ? (
        <AppProviders queryClient={queryClient}>
          {/* The messaging client lives under the Oxy provider and above every
              screen: `AlloRoot` builds it once the session names an account and
              gates the app on this device's enrollment. */}
          <AlloRoot>
            {!IS_WEB && <NotificationPermissionGate />}
            <RootStack />
          </AlloRoot>
        </AppProviders>
      ) : IS_WEB ? (
        <AppSplashScreen startFade={initialized} onFadeComplete={() => setSplashFaded(true)} />
      ) : null}
    </ThemeRoot>
  );
}
