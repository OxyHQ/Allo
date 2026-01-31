// Required polyfill for @oxyhq/services - must be imported first
import 'react-native-url-polyfill/auto';
// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { useFonts } from "expo-font";
import { Slot, usePathname } from "expo-router";
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
import { useColorScheme } from "@/hooks/useColorScheme";
import { useIsScreenNotMobile } from "@/hooks/useOptimizedMediaQuery";
import { useTheme } from '@/hooks/useTheme';

// Utils
import { routeMatchers } from '@/utils/routeUtils';

// Services & Utils
import { AppInitializer } from '@/lib/appInitializer';
import { startConnectionMonitoring } from '@/lib/network/connectionStatus';

// Styles
import '../styles/global.css';

// Types
interface SplashState {
  initializationComplete: boolean;
  startFade: boolean;
}

interface MainLayoutProps {
  isScreenNotMobile: boolean;
}

/**
 * MainLayout Component
 * Memoized to prevent unnecessary re-renders when parent updates
 */
const MainLayout: React.FC<MainLayoutProps> = memo(({ isScreenNotMobile }) => {
  const theme = useTheme();
  const pathname = usePathname();
  
  // Determine if BottomBar should be visible
  // Hide BottomBar on conversation routes (handled by /c/_layout.tsx)
  const isConversationRoute = routeMatchers.isConversationRoute(pathname);
  const shouldShowBottomBar = !isScreenNotMobile && !isConversationRoute;

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
      {/* Show SideBar only on large screens (when isScreenNotMobile is true) */}
      {isScreenNotMobile && <SideBar />}
      <View style={styles.mainContent}>
        <ThemedView style={styles.mainContentWrapper}>
          <Slot />
        </ThemedView>
      </View>
      {/* Show BottomBar only on small screens when NOT on conversation route */}
      {shouldShowBottomBar && <BottomBar />}
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function RootLayout() {
  // State
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
  });

  // Hooks
  const isScreenNotMobile = useIsScreenNotMobile();
  // Memoized instances
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  // Font Loading - Optimized: Load only essential fonts to reduce initial load time
  // Reduced from 13 fonts to 5 fonts (Inter: 4 weights, Phudu: 1 variable font)
  const [fontsLoaded, fontError] = useFonts({
    // Inter fonts - load only commonly used weights
    'Inter-Regular': require('@/assets/fonts/inter/Inter-Regular.otf'),
    'Inter-Medium': require('@/assets/fonts/inter/Inter-Medium.otf'),
    'Inter-SemiBold': require('@/assets/fonts/inter/Inter-SemiBold.otf'),
    'Inter-Bold': require('@/assets/fonts/inter/Inter-Bold.otf'),
    // Phudu - Variable font (handles all weights, load once)
    'Phudu': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
  });

  // Callbacks
  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

  const initializeApp = useCallback(async () => {
    // Don't block app - continue with system fonts if custom fonts not ready
    // This prevents the 6s fontfaceobserver timeout from blocking the app
    if (fontError) {
      console.warn('Font loading failed, using system fonts:', fontError);
    } else if (!fontsLoaded) {
      console.log('Fonts still loading, continuing with system fonts temporarily...');
    }

    const result = await AppInitializer.initializeApp(fontsLoaded || false);

    if (result.success) {
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    } else {
      console.error('App initialization failed:', result.error);
      // Still mark as complete to prevent blocking the app
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsLoaded, fontError]);


  // Initialize i18n once when the app mounts
  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      console.error('Failed to initialize i18n:', error);
    });
  }, []);

  // Load eager settings that don't block app initialization
  useEffect(() => {
    AppInitializer.loadEagerSettings();
  }, []);

  // React Query managers + connection monitoring - setup once on mount
  useEffect(() => {
    // React Query online manager using NetInfo
    const unsubscribeNetInfo = NetInfo.addEventListener((state) => {
      onlineManager.setOnline(Boolean(state.isConnected && state.isInternetReachable !== false));
    });

    // Start global connection status monitoring (powers OfflineBanner)
    const stopMonitoring = startConnectionMonitoring();

    // React Query focus manager using AppState
    const onAppStateChange = (status: AppStateStatus) => {
      focusManager.setFocused(status === 'active');
    };
    const appStateSub = AppState.addEventListener('change', onAppStateChange);

    return () => {
      unsubscribeNetInfo();
      stopMonitoring();
      appStateSub.remove();
    };
  }, []); // Empty deps - setup once

  // Initialize app with timeout - don't wait forever for fonts
  useEffect(() => {
    // Set timeout to initialize even if fonts haven't loaded (prevents blocking)
    const timeout = setTimeout(() => {
      if (!splashState.initializationComplete) {
        console.log('Font loading timeout - initializing app anyway');
        initializeApp();
      }
    }, 2000); // Give fonts 2 seconds, then continue anyway

    // Also call when fonts actually load
    if (fontsLoaded || fontError) {
      clearTimeout(timeout);
      initializeApp();
    }

    return () => clearTimeout(timeout);
  }, [fontsLoaded, fontError, initializeApp, splashState.initializationComplete]);

  useEffect(() => {
    // Start fade when initialization complete (fonts are optional, not required)
    if (splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [splashState.initializationComplete, splashState.startFade]);

  // Run deferred initialization after the app is visible
  useEffect(() => {
    if (appIsReady) {
      AppInitializer.initializeDeferred();
    }
  }, [appIsReady]);

  const colorScheme = useColorScheme();

  // Memoize app content to prevent unnecessary re-renders
  const appContent = useMemo(() => {
    if (!appIsReady) {
      return (
        <AppSplashScreen
          startFade={splashState.startFade}
          onFadeComplete={handleSplashFadeComplete}
        />
      );
    }

    return (
      <AppProviders
        colorScheme={colorScheme}
        queryClient={queryClient}
      >
        {/* Shows bottom sheet permission prompt when needed (native only) */}
        {Platform.OS !== 'web' && (
          <NotificationPermissionGate
            appIsReady={appIsReady}
            initializationComplete={splashState.initializationComplete}
          />
        )}
        <MainLayout isScreenNotMobile={isScreenNotMobile} />
        <RegisterPush />
        {/* BottomBar removed */}
      </AppProviders>
    );
  }, [
    appIsReady,
    splashState.startFade,
    splashState.initializationComplete,
    colorScheme,
    isScreenNotMobile,
    handleSplashFadeComplete,
    queryClient,
  ]);

  return (
    <ThemedView style={{ flex: 1 }}>
      {appContent}
    </ThemedView>
  );
}
