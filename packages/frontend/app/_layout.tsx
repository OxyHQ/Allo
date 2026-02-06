// Required polyfill for @oxyhq/services - must be imported first
import 'react-native-url-polyfill/auto';
// Import Reanimated early to ensure proper initialization before other modules
import 'react-native-reanimated';

import NetInfo from '@react-native-community/netinfo';
import { QueryClient, focusManager, onlineManager } from '@tanstack/react-query';
import { useFonts } from "expo-font";
import { Stack, usePathname } from "expo-router";
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
import { useOxy } from '@oxyhq/services';

// Utils
import { routeMatchers } from '@/utils/routeUtils';

// Services & Utils
import { AppInitializer } from '@/lib/appInitializer';
import { startConnectionMonitoring } from '@/lib/network/connectionStatus';
import { loadFontsWithFallback } from '@/utils/fontLoader';

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
  const { user: currentUser } = useOxy();

  const needsAuth = !currentUser;
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
      {isScreenNotMobile && <SideBar />}
      <View style={styles.mainContent}>
        <ThemedView style={styles.mainContentWrapper}>
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(chat)" redirect={needsAuth} />
            <Stack.Screen name="(auth)" redirect={!needsAuth} />
            <Stack.Screen name="calls" />
            <Stack.Screen name="+not-found" />
          </Stack>
        </ThemedView>
      </View>
      {shouldShowBottomBar && <BottomBar />}
    </View>
  );
});

MainLayout.displayName = 'MainLayout';

export default function RootLayout() {
  const [appIsReady, setAppIsReady] = useState(false);
  const [splashState, setSplashState] = useState<SplashState>({
    initializationComplete: false,
    startFade: false,
  });

  const isScreenNotMobile = useIsScreenNotMobile();
  const queryClient = useMemo(() => new QueryClient(QUERY_CLIENT_CONFIG), []);

  const [fontsLoaded, fontError] = useFonts({
    'Inter-Regular': require('@/assets/fonts/inter/Inter-Regular.otf'),
    'Inter-Medium': require('@/assets/fonts/inter/Inter-Medium.otf'),
    'Inter-SemiBold': require('@/assets/fonts/inter/Inter-SemiBold.otf'),
    'Inter-Bold': require('@/assets/fonts/inter/Inter-Bold.otf'),
    'Phudu': require('@/assets/fonts/Phudu-VariableFont_wght.ttf'),
  });

  const handleSplashFadeComplete = useCallback(() => {
    setAppIsReady(true);
  }, []);

  const initializeApp = useCallback(async () => {
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
      setSplashState((prev) => ({ ...prev, initializationComplete: true }));
    }
  }, [fontsLoaded, fontError]);


  useEffect(() => {
    AppInitializer.initializeI18n().catch((error) => {
      console.error('Failed to initialize i18n:', error);
    });
  }, []);

  useEffect(() => {
    AppInitializer.loadEagerSettings();
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
    if (splashState.initializationComplete) return;

    loadFontsWithFallback(fontsLoaded, fontError).then(() => {
      if (!splashState.initializationComplete) {
        initializeApp();
      }
    });
  }, [fontsLoaded, fontError, initializeApp, splashState.initializationComplete]);

  useEffect(() => {
    if (splashState.initializationComplete && !splashState.startFade) {
      setSplashState((prev) => ({ ...prev, startFade: true }));
    }
  }, [splashState.initializationComplete, splashState.startFade]);

  useEffect(() => {
    if (appIsReady) {
      AppInitializer.initializeDeferred();
    }
  }, [appIsReady]);

  const colorScheme = useColorScheme();

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
      <AppProviders colorScheme={colorScheme} queryClient={queryClient}>
        {Platform.OS !== 'web' && (
          <NotificationPermissionGate
            appIsReady={appIsReady}
            initializationComplete={splashState.initializationComplete}
          />
        )}
        <MainLayout isScreenNotMobile={isScreenNotMobile} />
        <RegisterPush />
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
