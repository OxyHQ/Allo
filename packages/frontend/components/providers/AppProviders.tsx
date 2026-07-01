/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { BottomSheetModalProvider } from '@gorhom/bottom-sheet';
import { MenuProvider } from 'react-native-popup-menu';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxyhq/services';
import { ImageResolverProvider, type ImageResolver } from '@oxyhq/bloom/image-resolver';

import ErrorBoundary from '@/components/ErrorBoundary';
import { BottomSheetProvider } from '@/context/BottomSheetContext';
import { HomeRefreshProvider } from '@/context/HomeRefreshContext';
import { Toaster } from '@/lib/sonner';
import i18n from '@/lib/i18n';
import { OXY_BASE_URL, OXY_CLIENT_ID } from '@/config';

interface AppProvidersProps {
  children: React.ReactNode;
  queryClient: QueryClient;
}

/**
 * App-wide media chokepoint for Bloom `Avatar`/image components.
 *
 * Registers a single `ImageResolverProvider` whose resolver turns an Oxy file
 * id (plus optional rendition variant) into the canonical Oxy media URL via
 * `oxyServices.getFileDownloadUrl` — the ONE place a media URL is built. Any
 * Bloom surface that renders `Avatar source={<fileId>} variant="thumb"` (e.g.
 * the sidebar `ProfileButton`) gets correctly-resolved media for free.
 */
function MediaResolverProvider({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();
  const resolver = useMemo<ImageResolver>(
    () => (id: string, variant?: string) => {
      if (!id) return undefined;
      return oxyServices.getFileDownloadUrl(id, variant ?? 'thumb');
    },
    [oxyServices],
  );
  return (
    <ImageResolverProvider value={resolver}>{children}</ImageResolverProvider>
  );
}

/**
 * Wraps the app with all necessary providers
 * Separated from _layout.tsx for better testability
 * Memoized to prevent re-renders when props don't change
 */
export const AppProviders = memo(function AppProviders({
  children,
  queryClient,
}: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <OxyProvider baseURL={OXY_BASE_URL} clientId={OXY_CLIENT_ID}>
            <MediaResolverProvider>
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
            </MediaResolverProvider>
          </OxyProvider>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});

