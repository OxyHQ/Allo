import type { ErrorBoundaryFallbackContext } from '@oxy.so/bloom/error-boundary';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons/RiErrorWarningLine';
import { useCallback, type ErrorInfo, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Platform, ScrollView } from 'react-native';

import { logger } from '@/utils/logger';

import {
  Button as LButton,
  Embed,
  HStack,
  IconCircle as LIconCircle,
  Text as LText,
  VStack,
  toElement,
} from '@oxy.so/bloom-language';
import { Card as LCard, ErrorBoundary as LErrorBoundary } from '@oxy.so/bloom-language/containers';

/**
 * The catching machinery (getDerivedStateFromError, componentDidCatch, the
 * retry reset) is Bloom's. What is Allo's is the wording and the two fallbacks:
 * the whole-app one below, and the section-sized one in `FeatureErrorBoundary`.
 */

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
  onError?: (error: Error, errorInfo: ErrorInfo) => void;
  /** Shows the error and component stack, as development builds always do. */
  showDetails?: boolean;
}

/** Retries after which the same failure is assumed to be persistent and a reload is offered. */
const RELOAD_AFTER_RETRIES = 2;

export default function ErrorBoundary({
  children,
  fallback,
  onError,
  showDetails = false,
}: ErrorBoundaryProps) {
  const handleError = useCallback(
    (error: Error, errorInfo: ErrorInfo) => {
      logger.error('[ErrorBoundary] Caught error', {
        error: error.toString(),
        stack: error.stack,
        componentStack: errorInfo.componentStack,
      });
      onError?.(error, errorInfo);
    },
    [onError],
  );

  return toElement(
    LErrorBoundary(Embed(children))
      .fallback(
        fallback !== undefined && fallback !== null
          ? Embed(fallback)
          : (context: ErrorBoundaryFallbackContext) =>
              Embed(<AppCrashFallback {...context} showDetails={showDetails} />),
      )
      .onError(handleError),
  );
}

/** A component rather than an inline render: the boundary is a class, and the fallback needs hooks. */
function AppCrashFallback({
  error,
  errorInfo,
  retry,
  retryCount,
  showDetails,
}: ErrorBoundaryFallbackContext & { showDetails: boolean }) {
  const { t } = useTranslation();
  const canReload = Platform.OS === 'web' && retryCount >= RELOAD_AFTER_RETRIES;

  return toElement(
    VStack(
      VStack(
        LIconCircle(RiErrorWarningLine),
        LText(t('error.boundary.title'))
          .font('title-2')
          .weight('semibold')
          .role('header')
          .textAlign('center'),
        LText(t('error.boundary.message')).font('body').foreground('muted').textAlign('center'),
        HStack(
          LButton(LText(t('error.boundary.retry'))).onPress(retry),
          canReload
            ? LButton(LText(t('error.boundary.reload')))
                .onPress(() => window.location.reload())
                .tint('neutral')
                .style('outline')
            : null,
        )
          .wrap()
          .justify('center')
          .spacing('sm'),
        __DEV__ || showDetails
          ? LCard(
              Embed(
                <ScrollView>
                  {toElement(
                    LText(error.toString(), errorInfo?.componentStack ?? '')
                      .font('caption-1')
                      .foreground('muted')
                      .selectable(),
                  )}
                </ScrollView>,
              ),
            )
              .style('subtle')
              .padding('all', 'md')
              .frame({ maxHeight: '200' })
              .alignSelf('stretch')
          : null,
      )
        .frame({ width: 'full', maxWidth: '480' })
        .align('center')
        .spacing('lg'),
    )
      .padding('all', '2xl')
      .background('background')
      .align('center')
      .justify('center')
      .grow(),
  );
}

/**
 * Error boundary scoped to one part of the screen.
 *
 * Use this, not the default export, anywhere a failure should stay local: a
 * component that throws while rendering one panel should not take the
 * navigation and every other panel down with it. `featureName` is what the
 * reader sees, so name the surface and not the module.
 */
export function FeatureErrorBoundary({
  children,
  featureName,
}: {
  children: ReactNode;
  featureName: string;
}) {
  const { t } = useTranslation();
  return toElement(
    LErrorBoundary(Embed(children))
      .title(t('error.feature.title', { feature: featureName }))
      .message(t('error.feature.message'))
      .retryLabel(t('error.boundary.retry'))
      .onError((error) => logger.error(`[${featureName}] Error`, error)),
  );
}
