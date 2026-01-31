import React, { Suspense, lazy } from 'react';
import type LottieView from 'lottie-react-native';
import { View, ActivityIndicator } from 'react-native';

/**
 * Lazy-loaded LottieView component
 * Reduces initial bundle size by loading Lottie only when needed
 *
 * Usage:
 * <LazyLottieView
 *   source={require('@/assets/animations/loading.json')}
 *   autoPlay
 *   loop
 *   style={{ width: 100, height: 100 }}
 * />
 */

// Lazy load the heavy Lottie library
const LottieViewLazy = lazy(() => import('lottie-react-native'));

type LottieViewProps = React.ComponentProps<typeof LottieView>;

interface LazyLottieViewProps extends LottieViewProps {
  fallback?: React.ReactNode;
}

export const LazyLottieView: React.FC<LazyLottieViewProps> = ({
  fallback,
  style,
  ...props
}) => {
  const defaultFallback = (
    <View style={[{ justifyContent: 'center', alignItems: 'center' }, style]}>
      <ActivityIndicator size="small" />
    </View>
  );

  return (
    <Suspense fallback={fallback || defaultFallback}>
      <LottieViewLazy style={style} {...props} />
    </Suspense>
  );
};

export default LazyLottieView;
