import React, { ErrorInfo, ReactNode, useCallback, useRef } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { ErrorBoundary as BloomErrorBoundary } from '@oxyhq/bloom/error-boundary';
import type { ErrorBoundaryFallbackContext } from '@oxyhq/bloom/error-boundary';
import { colors } from '@/styles/colors';
import { withTranslation } from 'react-i18next';

/**
 * Error Boundary Component
 *
 * WhatsApp/Telegram-level: Graceful error handling prevents full app crashes
 * Shows user-friendly error UI and allows recovery
 *
 * The catching machinery (getDerivedStateFromError, componentDidCatch, the
 * retry reset) lives in @oxyhq/bloom/error-boundary. What stays here is only
 * what is Allo's: the wording, the translations and the look of the two
 * fallbacks below.
 */

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    t: (key: string) => string;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    showDetails?: boolean; // Show error details in development
}

function ErrorBoundaryBase({ children, fallback, t, onError, showDetails }: Props) {
    // Counts errors caught by this boundary instance, for the crash log only.
    // Bloom's fallback context exposes `retryCount` (retries, not errors); the
    // two differ by one and the log has always reported errors.
    const errorCountRef = useRef(0);

    const handleError = useCallback(
        (error: Error, errorInfo: ErrorInfo) => {
            errorCountRef.current += 1;

            // Enhanced error logging
            console.error('[ErrorBoundary] Caught error:', {
                error: error.toString(),
                stack: error.stack,
                componentStack: errorInfo.componentStack,
                errorCount: errorCountRef.current,
            });

            // Call custom error handler (for analytics, Sentry, etc.)
            onError?.(error, errorInfo);
        },
        [onError]
    );

    const renderFallback = useCallback(
        ({ error, errorInfo, retry, retryCount }: ErrorBoundaryFallbackContext) => {
            // Full app reload for persistent errors
            const handleReload = () => {
                if (typeof window !== 'undefined') {
                    window.location.reload();
                }
            };

            // Show reload option if the error keeps coming back. Reaching the
            // third error requires two retries, so this is the same threshold
            // the previous `errorCount > 2` check used.
            const showReload = retryCount >= 2;

            return (
                <View style={styles.container}>
                    <Text style={styles.emoji}>😕</Text>
                    <Text style={styles.title}>{t('error.boundary.title')}</Text>
                    <Text style={styles.message}>
                        {t('error.boundary.message')}
                    </Text>

                    <View style={styles.buttonContainer}>
                        <TouchableOpacity
                            style={styles.retryButton}
                            onPress={retry}
                        >
                            <Text style={styles.retryText}>{t('error.boundary.retry')}</Text>
                        </TouchableOpacity>

                        {showReload && (
                            <TouchableOpacity
                                style={[styles.retryButton, styles.reloadButton]}
                                onPress={handleReload}
                            >
                                <Text style={[styles.retryText, styles.reloadText]}>Reload App</Text>
                            </TouchableOpacity>
                        )}
                    </View>

                    {/* Show error details in development */}
                    {(__DEV__ || showDetails) && (
                        <ScrollView style={styles.errorDetails}>
                            <Text style={styles.errorDetailsTitle}>Error Details:</Text>
                            <Text style={styles.errorDetailsText}>
                                {error.toString()}
                            </Text>
                            {errorInfo && (
                                <Text style={styles.errorDetailsText}>
                                    {errorInfo.componentStack}
                                </Text>
                            )}
                        </ScrollView>
                    )}
                </View>
            );
        },
        [t, showDetails]
    );

    return (
        <BloomErrorBoundary
            fallback={fallback ?? renderFallback}
            onError={handleError}
        >
            {children}
        </BloomErrorBoundary>
    );
}

// Wrap the component with translation HOC. Annotate the result so the emitted
// type does not reference react-i18next's internal helper types (TS2742): the
// HOC injects `t`, leaving the caller-facing props.
const ErrorBoundary: React.ComponentType<Omit<Props, 't'>> = withTranslation()(ErrorBoundaryBase);

/**
 * Error boundary scoped to one part of the screen.
 *
 * Use this, not the default export, anywhere a failure should stay local. The
 * top-level boundary replaces the whole interface with a full-screen apology,
 * which is the right last resort and the wrong first one: a component that
 * throws while rendering one panel should not take the navigation, the
 * conversation list and every other panel down with it.
 *
 * `featureName` is what the user reads, so name the surface and not the module.
 */
export function FeatureErrorBoundary({
    children,
    featureName,
}: {
    children: ReactNode;
    featureName: string;
}): React.JSX.Element {
    // Rendered directly rather than through a `Wrapper` component defined in
    // this function body. A component type created during render is a NEW type
    // on every render, so React unmounts and remounts the entire subtree each
    // time — which for a conversation panel means losing scroll position, focus
    // and any in-flight state, continuously.
    return (
        <BloomErrorBoundary
            fallback={
                <View style={styles.featureError}>
                    <Text style={styles.featureErrorText}>
                        {featureName} temporarily unavailable
                    </Text>
                    <Text style={styles.featureErrorSubtext}>
                        Please try again later
                    </Text>
                </View>
            }
            onError={(error) => {
                console.error(`[${featureName}] Error:`, error);
            }}
        >
            {children}
        </BloomErrorBoundary>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 20,
        backgroundColor: colors.primaryLight,
    },
    emoji: {
        fontSize: 64,
        marginBottom: 16,
    },
    title: {
        fontSize: 24,
        fontWeight: 'bold',
        marginBottom: 12,
        color: colors.primaryColor,
        textAlign: 'center',
    },
    message: {
        fontSize: 16,
        textAlign: 'center',
        marginBottom: 24,
        color: colors.COLOR_BLACK_LIGHT_3,
        lineHeight: 22,
        paddingHorizontal: 16,
    },
    buttonContainer: {
        flexDirection: 'row',
        gap: 12,
        marginTop: 8,
    },
    retryButton: {
        backgroundColor: colors.primaryColor,
        paddingHorizontal: 24,
        paddingVertical: 12,
        borderRadius: 12,
        minWidth: 120,
        alignItems: 'center',
        shadowColor: colors.shadow,
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.1,
        shadowRadius: 4,
        elevation: 3,
    },
    reloadButton: {
        backgroundColor: 'transparent',
        borderWidth: 1,
        borderColor: colors.primaryColor,
    },
    retryText: {
        color: 'white',
        fontSize: 16,
        fontWeight: '600',
    },
    reloadText: {
        color: colors.primaryColor,
    },
    errorDetails: {
        marginTop: 24,
        maxHeight: 200,
        width: '100%',
        padding: 12,
        backgroundColor: 'rgba(255, 0, 0, 0.1)',
        borderRadius: 8,
    },
    errorDetailsTitle: {
        fontSize: 14,
        fontWeight: 'bold',
        marginBottom: 8,
        color: colors.primaryColor,
    },
    errorDetailsText: {
        fontSize: 12,
        fontFamily: 'monospace',
        color: colors.COLOR_BLACK_LIGHT_3,
    },
    featureError: {
        padding: 20,
        alignItems: 'center',
        justifyContent: 'center',
    },
    featureErrorText: {
        fontSize: 16,
        fontWeight: '600',
        marginBottom: 4,
        color: colors.primaryColor,
    },
    featureErrorSubtext: {
        fontSize: 14,
        opacity: 0.6,
        color: colors.COLOR_BLACK_LIGHT_3,
    },
});

export default ErrorBoundary;
