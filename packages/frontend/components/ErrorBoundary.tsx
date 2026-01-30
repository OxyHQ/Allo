import React, { Component, ErrorInfo, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { colors } from '@/styles/colors';
import { withTranslation } from 'react-i18next';

/**
 * Error Boundary Component
 *
 * WhatsApp/Telegram-level: Graceful error handling prevents full app crashes
 * Shows user-friendly error UI and allows recovery
 */

interface Props {
    children: ReactNode;
    fallback?: ReactNode;
    t: (key: string) => string;
    onError?: (error: Error, errorInfo: ErrorInfo) => void;
    showDetails?: boolean; // Show error details in development
}

interface State {
    hasError: boolean;
    error: Error | null;
    errorInfo: ErrorInfo | null;
    errorCount: number; // Track consecutive errors
}

class ErrorBoundaryBase extends Component<Props, State> {
    public state: State = {
        hasError: false,
        error: null,
        errorInfo: null,
        errorCount: 0,
    };

    static getDerivedStateFromError(error: Error): Partial<State> {
        return { hasError: true };
    }

    componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        // Enhanced error logging
        console.error('[ErrorBoundary] Caught error:', {
            error: error.toString(),
            stack: error.stack,
            componentStack: errorInfo.componentStack,
            errorCount: this.state.errorCount + 1,
        });

        // Update state with error details
        this.setState(prev => ({
            error,
            errorInfo,
            errorCount: prev.errorCount + 1,
        }));

        // Call custom error handler (for analytics, Sentry, etc.)
        this.props.onError?.(error, errorInfo);

        // TODO: Send to error tracking service
        // logErrorToService({ error, errorInfo, userAgent: navigator.userAgent });
    }

    private handleRetry = () => {
        this.setState({
            hasError: false,
            error: null,
            errorInfo: null,
            // Keep error count to detect repeated crashes
        });
    };

    private handleReload = () => {
        // Full app reload for persistent errors
        if (typeof window !== 'undefined') {
            window.location.reload();
        }
    };

    render() {
        if (this.state.hasError) {
            if (this.props.fallback) {
                return this.props.fallback;
            }

            // Show reload option if error occurred multiple times
            const showReload = this.state.errorCount > 2;

            return (
                <View style={styles.container}>
                    <Text style={styles.emoji}>😕</Text>
                    <Text style={styles.title}>{this.props.t("error.boundary.title")}</Text>
                    <Text style={styles.message}>
                        {this.props.t("error.boundary.message")}
                    </Text>

                    <View style={styles.buttonContainer}>
                        <TouchableOpacity
                            style={styles.retryButton}
                            onPress={this.handleRetry}
                        >
                            <Text style={styles.retryText}>{this.props.t("error.boundary.retry")}</Text>
                        </TouchableOpacity>

                        {showReload && (
                            <TouchableOpacity
                                style={[styles.retryButton, styles.reloadButton]}
                                onPress={this.handleReload}
                            >
                                <Text style={[styles.retryText, styles.reloadText]}>Reload App</Text>
                            </TouchableOpacity>
                        )}
                    </View>

                    {/* Show error details in development */}
                    {(__DEV__ || this.props.showDetails) && this.state.error && (
                        <ScrollView style={styles.errorDetails}>
                            <Text style={styles.errorDetailsTitle}>Error Details:</Text>
                            <Text style={styles.errorDetailsText}>
                                {this.state.error.toString()}
                            </Text>
                            {this.state.errorInfo && (
                                <Text style={styles.errorDetailsText}>
                                    {this.state.errorInfo.componentStack}
                                </Text>
                            )}
                        </ScrollView>
                    )}
                </View>
            );
        }

        return this.props.children;
    }
}

// Wrap the component with translation HOC
const ErrorBoundary = withTranslation()(ErrorBoundaryBase);

/**
 * Smaller error boundary for specific features
 * Falls back to a minimal error state instead of full screen
 */
export function FeatureErrorBoundary({
    children,
    featureName,
}: {
    children: ReactNode;
    featureName: string;
}): JSX.Element {
    const Wrapper = ({ children: wrappedChildren }: { children: ReactNode }) => (
        <ErrorBoundaryBase
            t={(key: string) => key}
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
            {wrappedChildren}
        </ErrorBoundaryBase>
    );

    return <Wrapper>{children}</Wrapper>;
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
