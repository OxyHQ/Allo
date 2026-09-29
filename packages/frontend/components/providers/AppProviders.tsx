/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import React, { memo, useMemo } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { KeyboardProvider } from 'react-native-keyboard-controller';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import { OxyProvider, useOxy } from '@oxy.so/services';
import { ImageResolverProvider, type ImageResolver } from '@oxy.so/bloom/image-resolver';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';

import ErrorBoundary from '@/components/ErrorBoundary';
import i18n, { setLanguage } from '@/lib/i18n';
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES } from '@/lib/constants';
import { OXY_CLIENT_ID } from '@/config';
import { oxyServices } from '@/lib/oxy';
import { createStickersClient } from '@oxy.so/stickers';
import { StickersProvider } from '@oxy.so/stickers/react';
import { configureLottieWeb } from '@/lib/chat/lottieWeb';
import { logger } from '@/utils/logger';

/**
 * Oxy's shared sticker catalogue, read through this app's OxyServices. One client
 * for the app: it memoizes resolved stickers, which never change once published.
 */
const stickersClient = createStickersClient(oxyServices);

// Before any sticker renders: the web Lottie renderer loads from this origin.
configureLottieWeb();

interface AppProvidersProps {
  children: React.ReactNode;
  queryClient: QueryClient;
}

/**
 * App-wide media chokepoint for Bloom `Avatar`/image components.
 *
 * Registers a single `ImageResolverProvider` whose resolver turns an Oxy file
 * id (plus optional rendition variant) into the canonical Oxy media URL via
 * `oxyServices.assets.publicUrl` — the ONE place a media URL is built. Any
 * Bloom surface that renders `Avatar source={<fileId>} variant="thumb"` (e.g.
 * the sidebar `ProfileButton`) gets correctly-resolved media for free.
 */
function MediaResolverProvider({ children }: { children: React.ReactNode }) {
  const { oxyServices } = useOxy();
  const resolver = useMemo<ImageResolver>(
    () => (id: string, variant?: string) => {
      if (!id) return undefined;
      return oxyServices.assets.publicUrl(id, variant ?? 'thumb');
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
        <KeyboardProvider>
        <QueryClientProvider client={queryClient}>
          <OxyProvider
            oxyServices={oxyServices}
            clientId={OXY_CLIENT_ID}
            language={{
              supportedLocales: SUPPORTED_LANGUAGES,
              fallbackLocale: DEFAULT_LANGUAGE,
              onChange: setLanguage,
              onError: (error, locale) =>
                logger.error('Failed to follow the Oxy-resolved language', error, { locale }),
            }}
          >
            <StickersProvider client={stickersClient}>
            <MediaResolverProvider>
              <I18nextProvider i18n={i18n}>
                <ErrorBoundary>
                  {children}
                  <ConnectionStatusToasts />
                  <StatusBar style="auto" />
                </ErrorBoundary>
              </I18nextProvider>
            </MediaResolverProvider>
            </StickersProvider>
          </OxyProvider>
        </QueryClientProvider>
        </KeyboardProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});

