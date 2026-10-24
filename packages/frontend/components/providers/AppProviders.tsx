/**
 * AppProviders Component
 * Centralizes all provider components for better organization
 * Memoized to prevent unnecessary re-renders
 */

import type React from 'react';
import { memo } from 'react';
import { I18nextProvider } from 'react-i18next';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, initialWindowMetrics } from 'react-native-safe-area-context';
import { OxyProvider } from '@oxy.so/services/ui/client';
import { ConnectionStatusToasts } from '@oxy.so/bloom/connection-status';
import { OverlayInertBoundary, PortalOutlet, PortalProvider } from '@oxy.so/bloom/portal';
import { SurfaceHost } from '@oxy.so/bloom/surfaces';

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
}

/**
 * Wraps the app with all necessary providers
 * Separated from _layout.tsx for better testability
 * Memoized to prevent re-renders when props don't change
 */
export const AppProviders = memo(function AppProviders({ children }: AppProvidersProps) {
  return (
    <SafeAreaProvider initialMetrics={initialWindowMetrics}>
      <GestureHandlerRootView style={{ flex: 1 }}>
        {/* No KeyboardProvider here: OxyProvider mounts the one. A second one above it
            took the native keyboard events, so every keyboard hook under OxyProvider read
            a closed keyboard. */}
        {/* OxyProvider owns the app's React Query client; a second client
            above it was shadowed and never used. */}
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
            <I18nextProvider i18n={i18n}>
              <ErrorBoundary>
                {/* Native portals (`AliaChatSheet`) render only into a `PortalOutlet`
                    mounted by the app, after the content they paint over. The inert
                    boundary wraps everything but the outlet and the surface host. */}
                <PortalProvider>
                  <OverlayInertBoundary>{children}</OverlayInertBoundary>
                  {/* Bloom's one surface stack (sheets, menus, confirm()). OxyProvider
                      mounts its provider above these providers; this host takes the
                      stack over, so a surface renders inside i18n, the query client
                      and the stickers. */}
                  <SurfaceHost />
                  <ConnectionStatusToasts />
                  <PortalOutlet />
                </PortalProvider>
              </ErrorBoundary>
            </I18nextProvider>
          </StickersProvider>
        </OxyProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
});
