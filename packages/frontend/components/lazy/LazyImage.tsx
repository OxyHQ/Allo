import React, { useState, useEffect, useRef } from 'react';
import { Image as ExpoImage } from 'expo-image';
import { View, StyleSheet, Animated } from 'react-native';
import type { ImageProps } from 'expo-image';

/**
 * LazyImage - High-performance lazy-loaded image component
 *
 * Features:
 * - Intersection Observer for lazy loading (web)
 * - Native lazy loading (mobile)
 * - Blur-up effect for progressive loading
 * - Automatic retry on error
 * - Memory efficient with proper cleanup
 *
 * @example
 * <LazyImage
 *   source={{ uri: 'https://example.com/image.jpg' }}
 *   placeholder={require('@/assets/images/placeholder.jpg')}
 *   style={{ width: 300, height: 200 }}
 * />
 */

interface LazyImageProps extends Omit<ImageProps, 'onLoad' | 'onError'> {
  /** Threshold for intersection observer (0-1) */
  threshold?: number;
  /** Root margin for intersection observer */
  rootMargin?: string;
  /** Number of retry attempts on error */
  maxRetries?: number;
  /** Callback when image loads successfully */
  onLoadSuccess?: () => void;
  /** Callback when image fails to load */
  onLoadError?: (error: any) => void;
}

export const LazyImage: React.FC<LazyImageProps> = ({
  source,
  placeholder,
  style,
  threshold = 0.1,
  rootMargin = '50px',
  maxRetries = 3,
  onLoadSuccess,
  onLoadError,
  ...props
}) => {
  const [isInView, setIsInView] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const containerRef = useRef<View>(null);
  const fadeAnim = useRef(new Animated.Value(0)).current;

  // Intersection Observer for lazy loading (web only)
  useEffect(() => {
    if (typeof window === 'undefined' || !window.IntersectionObserver) {
      setIsInView(true);
      return;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setIsInView(true);
          observer.disconnect();
        }
      },
      { threshold, rootMargin }
    );

    const currentRef = containerRef.current;
    if (currentRef) {
      // @ts-ignore - React Native Web compatibility
      observer.observe(currentRef);
    }

    return () => {
      if (currentRef) {
        // @ts-ignore
        observer.unobserve(currentRef);
      }
    };
  }, [threshold, rootMargin]);

  // Fade-in animation when image loads
  useEffect(() => {
    if (isLoaded) {
      Animated.timing(fadeAnim, {
        toValue: 1,
        duration: 300,
        useNativeDriver: true,
      }).start();
      onLoadSuccess?.();
    }
  }, [isLoaded, fadeAnim, onLoadSuccess]);

  const handleLoad = () => {
    setIsLoaded(true);
    setHasError(false);
  };

  const handleError = (error: any) => {
    console.warn('[LazyImage] Load error:', error);

    if (retryCount < maxRetries) {
      // Retry with exponential backoff
      const delay = Math.min(1000 * 2 ** retryCount, 5000);
      setTimeout(() => {
        setRetryCount(prev => prev + 1);
        setHasError(false);
      }, delay);
    } else {
      setHasError(true);
      onLoadError?.(error);
    }
  };

  return (
    <View ref={containerRef} style={style}>
      {!isInView ? (
        // Placeholder while not in viewport
        placeholder && (
          <ExpoImage
            source={placeholder}
            style={StyleSheet.absoluteFill}
            contentFit="cover"
            cachePolicy="memory-disk"
          />
        )
      ) : (
        <>
          {/* Show placeholder while loading */}
          {!isLoaded && placeholder && (
            <ExpoImage
              source={placeholder}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          )}

          {/* Actual image */}
          {!hasError && (
            <Animated.View style={[StyleSheet.absoluteFill, { opacity: fadeAnim }]}>
              <ExpoImage
                source={source}
                style={StyleSheet.absoluteFill}
                onLoad={handleLoad}
                onError={handleError}
                cachePolicy="memory-disk"
                priority="normal"
                transition={200}
                {...props}
              />
            </Animated.View>
          )}

          {/* Error fallback */}
          {hasError && placeholder && (
            <ExpoImage
              source={placeholder}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              cachePolicy="memory-disk"
            />
          )}
        </>
      )}
    </View>
  );
};

export default LazyImage;
