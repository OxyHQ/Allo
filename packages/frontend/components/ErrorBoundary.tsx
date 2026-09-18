import React, { useCallback, type ErrorInfo, type ReactNode } from 'react';
import { Platform, ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Button } from '@oxy.so/bloom/button';
import { Card } from '@oxy.so/bloom/card';
import { ErrorBoundary as BloomErrorBoundary, type ErrorBoundaryFallbackContext } from '@oxy.so/bloom/error-boundary';
import { IconCircle } from '@oxy.so/bloom/icon-circle';
import { RiErrorWarningLine } from '@oxy.so/bloom/icons';
import { useTheme } from '@oxy.so/bloom/theme';
import { Text } from '@oxy.so/bloom/typography';

import { logger } from '@/utils/logger';

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

export default function ErrorBoundary({ children, fallback, onError, showDetails = false }: ErrorBoundaryProps) {
  const handleError = useCallback(
    (error: Error, errorInfo: ErrorInfo) => {
      logger.error('[ErrorBoundary] Caught error', { error: error.toString(), stack: error.stack, componentStack: errorInfo.componentStack });
      onError?.(error, errorInfo);
    },
    [onError],
  );

  return (
    <BloomErrorBoundary
      fallback={fallback ?? ((context: ErrorBoundaryFallbackContext) => <AppCrashFallback {...context} showDetails={showDetails} />)}
      onError={handleError}
    >
      {children}
    </BloomErrorBoundary>
  );
}

/** A component rather than an inline render: the boundary is a class, and the fallback needs hooks. */
function AppCrashFallback({ error, errorInfo, retry, retryCount, showDetails }: ErrorBoundaryFallbackContext & { showDetails: boolean }) {
  const { t } = useTranslation();
  const theme = useTheme();
  const canReload = Platform.OS === 'web' && retryCount >= RELOAD_AFTER_RETRIES;

  return (
    <View style={[styles.root, { backgroundColor: theme.colors.background }]}>
      <View style={styles.column}>
        <IconCircle icon={RiErrorWarningLine} />
        <Text variant="title-2-semibold" accessibilityRole="header" style={styles.centered}>
          {t('error.boundary.title')}
        </Text>
        <Text variant="body-regular" style={[styles.centered, { color: theme.colors.textSecondary }]}>
          {t('error.boundary.message')}
        </Text>
        <View style={styles.actions}>
          <Button onPress={retry}>{t('error.boundary.retry')}</Button>
          {canReload ? (
            <Button variant="secondary" onPress={() => window.location.reload()}>
              {t('error.boundary.reload')}
            </Button>
          ) : null}
        </View>
        {__DEV__ || showDetails ? (
          <Card variant="filled" style={styles.details}>
            <ScrollView>
              <Text variant="caption-1-regular" selectable style={{ color: theme.colors.textSecondary }}>
                {error.toString()}
                {errorInfo?.componentStack ?? ''}
              </Text>
            </ScrollView>
          </Card>
        ) : null}
      </View>
    </View>
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
export function FeatureErrorBoundary({ children, featureName }: { children: ReactNode; featureName: string }) {
  const { t } = useTranslation();
  return (
    <BloomErrorBoundary
      title={t('error.feature.title', { feature: featureName })}
      message={t('error.feature.message')}
      retryLabel={t('error.boundary.retry')}
      onError={(error) => logger.error(`[${featureName}] Error`, error)}
    >
      {children}
    </BloomErrorBoundary>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24 },
  column: { alignItems: 'center', gap: 16, width: '100%', maxWidth: 480 },
  centered: { textAlign: 'center' },
  actions: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 8 },
  details: { alignSelf: 'stretch', maxHeight: 200, padding: 12 },
});
