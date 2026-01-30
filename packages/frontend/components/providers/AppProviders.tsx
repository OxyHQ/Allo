/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider } from '@oxyhq/services';

import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { Toaster } from '@/lib/sonner';
import i18n from '@/lib/i18n';
import { QUERY_CLIENT_CONFIG } from '@/components/providers/constants';
import { OXY_BASE_URL } from '@/config';

interface AppProvidersProps {
  children: React.ReactNode;
  colorScheme: 'light' | 'dark' | null | undefined;
  queryClient: QueryClient;
}

/**
 * Wraps the app with all necessary providers
 * Separated from _layout.tsx for better testability
 * Memoized to prevent re-renders when props don't change
 */
export const AppProviders = memo(function AppProviders({
  children,
  colorScheme,
  queryClient,
}: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <OxyProvider baseURL={OXY_BASE_URL}>
            <I18nextProvider i18n={i18n}>
              <BottomSheetModalProvider>
                <BottomSheetProvider>
                  <MenuProvider>
                    <ErrorBoundary>
                      <HomeRefreshProvider>
                        {children}
                        <StatusBar style="auto" />
                        <Toaster
                          position="bottom-center"
                          swipeToDismissDirection="left"
                          offset={15}
                        />
                      </HomeRefreshProvider>
                    </ErrorBoundary>
                  </MenuProvider>
                </BottomSheetProvider>
              </BottomSheetModalProvider>
            </I18nextProvider>
          </OxyProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});

