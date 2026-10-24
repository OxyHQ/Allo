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
import { useAccountTheme, useOxy } from '@oxy.so/services/ui/client';
import { focusManager, onlineManager } from '@tanstack/react-query';
import { Stack } from 'expo-router';
import { useEffect, useState, type ReactNode } from 'react';
import { AppState, Platform, type AppStateStatus } from 'react-native';

import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/notifications/NotificationPermissionGate';
import { NavigationTheme } from '@/components/providers/NavigationTheme';
import { AppProviders } from '@/components/providers/AppProviders';
import { AlloRoot } from '@/lib/allo/AlloRoot';
import { AppInitializer } from '@/lib/appInitializer';
import { useAppLanguage } from '@/lib/i18n';
import { usePendingHref } from '@/lib/navigation/usePendingHref';
import { startConnectionMonitoring } from '@/lib/network/connectionStatus';
import { oxyServices } from '@/lib/oxy';
import { DEFAULT_COLOR_PRESET, THEME_PERSIST_KEY, THEME_STORAGE } from '@/lib/theme';

import '../styles/global.css';

// NATIVE ONLY: hold the OS splash until init has run; `useHideNativeSplashWhenReady`
// releases it. A no-op on web, where `AppSplashScreen` covers the same window.
preventNativeSplashAutoHide();

const IS_WEB = Platform.OS === 'web';

/**
 * An Oxy file id (or an absolute URL) as the URL to draw right now, for every
 * Bloom `Avatar` and image: the SDK's `renderUrl` passes a URL through, reuses
 * one it already resolved for this caller, and otherwise builds the public one.
 */
function resolveImage(ref: string, variant?: string): string | undefined {
  return ref ? oxyServices.assets.renderUrl(ref, variant ?? 'thumb') : undefined;
}

/**
 * Bloom. It keeps this device's last theme, so a cold start paints it at once;
 * the Oxy account's theme lands on top of it (`useAccountTheme` in
 * `RootStack`). Bloom's own words (Cancel, dates) follow the app's language.
 */
function ThemeRoot({ children }: { children: ReactNode }) {
  const language = useAppLanguage();
  return (
    <BloomProvider
      fonts
      defaultMode="system"
      defaultColorPreset={DEFAULT_COLOR_PRESET}
      persistKey={THEME_PERSIST_KEY}
      storage={THEME_STORAGE}
      imageResolver={resolveImage}
      locale={language}
      // Web shows its own splash while fonts load; native is still behind the OS splash.
      onFontsLoading={IS_WEB ? <AppSplashScreen /> : null}
    >
      {children}
    </BloomProvider>
  );
}

/**
 * Signed out, the chat group redirects to sign-in, and the other way round. A
 * link opened while signed out is kept and followed once signed in, rather than
 * lost to the redirect (`usePendingHref`).
 */
function RootStack() {
  const { user } = useOxy();
  const signedIn = Boolean(user);
  // The Oxy account's theme: its colour always, its mode while this device
  // follows the account. Applied once, below both the Oxy and Bloom providers.
  useAccountTheme();
  usePendingHref(signedIn);
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Protected guard={signedIn}>
        <Stack.Screen name="(chat)" />
      </Stack.Protected>
      <Stack.Protected guard={!signedIn}>
        <Stack.Screen name="(auth)" />
      </Stack.Protected>
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
  const [ready, setReady] = useState(false);

  useDeviceSignals();
  useHideNativeSplashWhenReady(ready);

  // Only the bundled translations are waited for. The session restores inside
  // OxyProvider and the theme is Bloom's, so nothing here waits on the network.
  useEffect(() => {
    AppInitializer.initializeI18n()
      .catch((error) => console.error('Failed to initialize i18n:', error))
      .finally(() => setReady(true));
  }, []);

  useEffect(() => {
    if (ready) void AppInitializer.initializeDeferred();
  }, [ready]);

  return (
    <ThemeRoot>
      {ready ? (
        <AppProviders>
          {/* The messaging client lives under the Oxy provider and above every
              screen: `AlloRoot` builds it once the session names an account and
              gates the app on this device's enrollment. */}
          <AlloRoot>
            {!IS_WEB && <NotificationPermissionGate />}
            <NavigationTheme>
              <RootStack />
            </NavigationTheme>
          </AlloRoot>
        </AppProviders>
      ) : IS_WEB ? (
        <AppSplashScreen />
      ) : null}
    </ThemeRoot>
  );
}
