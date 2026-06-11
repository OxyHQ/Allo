// Required polyfill for @oxyhq/services - must be imported first
import 'react-native-url-polyfill/auto';
// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { BloomThemeProvider } from '@oxyhq/bloom';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';

import { Stack, usePathname, useRouter } from "expo-router";
import React, { useCallback, useEffect, useMemo, useState, memo } from "react";
import { AppState, Platform, StyleSheet, View, type AppStateStatus } from "react-native";

// Components
import AppSplashScreen from '@/components/AppSplashScreen';
import { NotificationPermissionGate } from '@/components/notifications/NotificationPermissionGate';
import RegisterPush from '@/components/notifications/RegisterPushToken';
import { SideBar } from "@/components/SideBar";
import { BottomBar } from "@/components/layout/BottomBar";
import { ThemedView } from "@/components/ThemedView";
import { AppProviders } from '@/components/providers/AppProviders';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';

// Hooks
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useTheme } from '@/hooks/useTheme';
import { useAuthGate } from '@/hooks/useAuthGate';
import { useAuthCleanup } from '@/hooks/useAuthCleanup';
import { useAppearanceStore } from '@/stores/appearanceStore';
import type { AppColorName, ThemeMode } from '@oxyhq/bloom/theme';

// Utils
import { routeMatchers } from '@/utils/routeUtils';
import {
  captureInitialDeepLink,
  consumePendingDeepLink,
  stashCapturedDeepLink,
} from '@/lib/pendingDeepLink';

// Services & Utils
import { AppInitializer } from '@/lib/appInitializer';
import { startConnectionMonitoring } from '@/lib/network/connectionStatus';


// Styles
import '../styles/global.css';

// Types
interface MainLayoutProps {
  isScreenNotMobile: boolean;
  isAuthenticated: boolean;
}

/**
 * MainLayout Component
 * Memoized to prevent unnecessary re-renders when parent updates
 */
const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile, isAuthenticated }) => {
  const theme = useTheme();
  const pathname = usePathname();

  const isConversationRoute = routeMatchers.isConversationRoute(pathname);
  const shouldShowBottomBar = isAuthenticated && !isScreenNotMobile && !isConversationRoute;

  const styles = useMemo(() => StyleSheet.create({
    container: {
      flex: 1,
      width: '100%',
      marginHorizontal: 'auto',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      backgroundColor: theme.colors.background,
    },
    mainContent: {
      marginHorizontal: isScreenNotMobile ? 'auto' : 0,
      justifyContent: 'space-between',
      flexDirection: isScreenNotMobile ? 'row' : 'column',
      flex: 1,
      backgroundColor: theme.colors.background,
    },
    mainContentWrapper: {
      flex: isScreenNotMobile ? 2.2 : 1,
      ...(isScreenNotMobile ? {
        borderLeftWidth: 0.5,
        borderRightWidth: 0.5,
        borderColor: theme.colors.border,
      } : {}),
      backgroundColor: theme.colors.background,
    },
  }), [isScreenNotMobile, theme.colors.background, theme.colors.border]);

  return (
    <View style={styles.container}>
      {isScreenNotMobile && isAuthenticated && <SideBar />}
      <View style={styles.mainContent}>
        <ThemedView style={styles.mainContentWrapper}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Protected guard={isAuthenticated}>
              <Stack.Screen name="(chat)" />
              <Stack.Screen name="calls" />
            </Stack.Protected>
            <Stack.Protected guard={!isAuthenticated}>
              <Stack.Screen name="(auth)" />
            </Stack.Protected>
            <Stack.Screen name="+not-found" />
          </Stack>
        </ThemedView>
      </View>
      {shouldShowBottomBar && <BottomBar />}
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

interface AppGateProps {
  isScreenNotMobile: boolean;
  initializationComplete: boolean;
}

/**
 * AppGate Component
 *
 * Lives inside the providers so it can read auth state and the query client.
 * Owns the splash → app handoff: keeps the splash visible until both the app's
 * own init finished AND auth has resolved (`useAuthGate`), so the navigator
 * mounts exactly once with the correct `(chat)` vs `(auth)` guard — no flash of
 * the wrong screen.
 */
const AppGate: React.FC<AppGateProps> = memo(({ isScreenNotMobile, initializationComplete }) => {
  const { isAuthenticated, isResolved } = useAuthGate();
  const [appIsReady, setAppIsReady] = useState(false);
  const router = useRouter();

  // Watch for logout / account switch and tear down session state.
  useAuthCleanup();

  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

  // Run heavy/deferred init (Signal Protocol, notifications) only after the app
  // is visible AND auth has resolved — so encryption setup doesn't race the
  // session restore that provides the auth token it needs.
  useEffect(() => {
    if (appIsReady) {
      AppInitializer.initializeDeferred();
    }
  }, [appIsReady]);

  // Deep-link continuation — stash phase: only once auth has resolved to
  // "unauthenticated" (the user will see the welcome screen) do we promote the
  // captured cold-start path into the pending slot for replay after sign-in.
  // An already-authenticated cold start never reaches here, so it never stashes
  // and the replay effect below stays a no-op (Expo Router already navigated).
  useEffect(() => {
    if (isResolved && !isAuthenticated) {
      stashCapturedDeepLink();
    }
  }, [isResolved, isAuthenticated]);

  // Deep-link continuation — replay phase: once the user is authenticated,
  // forward them to the path they originally requested while logged out (if
  // any). The stored value is a validated internal absolute path; cast to the
  // router's own parameter type (Expo Router's typed routes can't statically
  // know a runtime string).
  useEffect(() => {
    if (appIsReady && isAuthenticated) {
      const pending = consumePendingDeepLink();
      if (pending) {
        const href: Parameters<typeof router.replace>[0] =
          pending as Parameters<typeof router.replace>[0];
        router.replace(href);
      }
    }
  }, [appIsReady, isAuthenticated, router]);

  if (!appIsReady) {
    return (
      <AppSplashScreen
        startFade={initializationComplete && isResolved}
        onFadeComplete={handleSplashFadeComplete}
      />
    );
  }

  return (
    <>
      {Platform.OS !== 'web' && isAuthenticated && (
        <NotificationPermissionGate
          appIsReady={appIsReady}
          initializationComplete={initializationComplete}
        />
      )}
      <MainLayout isScreenNotMobile={isScreenNotMobile} isAuthenticated={isAuthenticated} />
      <RegisterPush />
    </>
  );
});

AppGate.displayName = 'AppGate';

export default function RootLayout() {
  const [initializationComplete, setInitializationComplete] = useState(false);

  const isScreenNotMobile = useIsScreenNotMobile();
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  const initializeApp = useCallback(async () => {
    const result = await AppInitializer.initializeApp();
    if (!result.success) {
      console.error('App initialization failed:', result.error);
    }
    setInitializationComplete(true);
  }, []);

  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      console.error('Failed to initialize i18n:', error);
    });
  }, []);

  useEffect(() => {
    AppInitializer.loadEagerSettings();
  }, []);

  // Capture a cold-start deep link so we can resume it after login (native).
  useEffect(() => {
    captureInitialDeepLink().catch((error) => {
      console.warn('Failed to capture initial deep link:', error);
    });
  }, []);

  useEffect(() => {
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    const stopMonitoring = startConnectionMonitoring();

    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      stopMonitoring();
      appStateSub.remove();
    };
  }, []);

  useEffect(() => {
    if (initializationComplete) return;
    initializeApp();
  }, [initializeApp, initializationComplete]);

  const mySettings = useAppearanceStore((s) => s.mySettings);
  const updateMySettings = useAppearanceStore((s) => s.updateMySettings);

  // Bloom's color preset names (`teal`, `blue`, …, `oxy`) differ from Allo's
  // legacy `colorTheme` ids (`classic`, …). Keep Bloom's preset separate from
  // the chat-bubble theme so existing chat customizations still work.
  const APP_COLOR_NAMES = new Set([
    'teal', 'blue', 'green', 'amber', 'yellow', 'red', 'purple',
    'pink', 'sky', 'orange', 'mint', 'oxy', 'faircoin',
  ]);
  const themeMode = mySettings?.appearance?.themeMode;
  const bloomMode: ThemeMode = themeMode === 'light' || themeMode === 'dark' ? themeMode : 'system';
  const rawPreset = mySettings?.appearance?.primaryColor;
  const bloomColorPreset: AppColorName = (rawPreset && APP_COLOR_NAMES.has(rawPreset))
    ? (rawPreset as AppColorName)
    : 'oxy';

  const handleModeChange = useCallback((mode: ThemeMode) => {
    void updateMySettings({
      appearance: {
        ...(mySettings?.appearance ?? { themeMode: 'system' as const }),
        themeMode: mode === 'adaptive' ? 'system' : (mode as 'light' | 'dark' | 'system'),
      },
    });
  }, [mySettings?.appearance, updateMySettings]);

  const handleColorPresetChange = useCallback((preset: AppColorName) => {
    void updateMySettings({
      appearance: {
        ...(mySettings?.appearance ?? { themeMode: 'system' as const }),
        primaryColor: preset,
      },
    });
  }, [mySettings?.appearance, updateMySettings]);

  return (
    <BloomThemeProvider
      mode={bloomMode}
      colorPreset={bloomColorPreset}
      onModeChange={handleModeChange}
      onColorPresetChange={handleColorPresetChange}
      fonts
      onFontsLoading={<AppSplashScreen />}
    >
      <ThemedView style={{ flex: 1 }}>
        <AppProviders queryClient={queryClient}>
          <AppGate
            isScreenNotMobile={isScreenNotMobile}
            initializationComplete={initializationComplete}
          />
        </AppProviders>
      </ThemedView>
    </BloomThemeProvider>
  );
}
