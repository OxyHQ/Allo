import React, { useRef, useEffect, useMemo, useCallback } from 'react';
import { InteractionManager } from 'react-native';

/**
 * Performance Optimization Utilities
 *
 * WhatsApp/Telegram-level: Smooth, instant interactions
 * Eliminates jank and lag for professional UX
 */

/**
 * Debounce function
 * Delays execution until after wait time has elapsed since last call
 *
 * Use for: Search input, form validation, API calls triggered by typing
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): (...args: Parameters<T>) => void {
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  return function debounced(...args: Parameters<T>) {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      func(...args);
      timeoutId = null;
    }, wait);
  };
}

/**
 * React hook for debounced value
 *
 * @example
 * const [searchTerm, setSearchTerm] = useState('');
 * const debouncedSearch = useDebounce(searchTerm, 300);
 *
 * useEffect(() => {
 *   // API call with debounced value
 *   searchAPI(debouncedSearch);
 * }, [debouncedSearch]);
 */
export function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = React.useState(value);

  useEffect(() => {
    const handler = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(handler);
    };
  }, [value, delay]);

  return debouncedValue;
}

/**
 * Throttle function
 * Executes at most once per specified interval
 *
 * Use for: Scroll handlers, resize handlers, animation frames
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  limit: number
): (...args: Parameters<T>) => void {
  let inThrottle: boolean;
  let lastRan: number;

  return function throttled(...args: Parameters<T>) {
    if (!inThrottle) {
      func(...args);
      lastRan = Date.now();
      inThrottle = true;

      setTimeout(() => {
        inThrottle = false;
      }, limit);
    }
  };
}

/**
 * Run heavy task after interactions complete
 * Prevents blocking UI during animations/gestures
 *
 * @example
 * runAfterInteractions(() => {
 *   // Heavy computation or data loading
 *   processLargeDataset();
 * });
 */
export function runAfterInteractions(callback: () => void): void {
  InteractionManager.runAfterInteractions(() => {
    callback();
  });
}

/**
 * Hook to defer rendering until after interactions
 *
 * @example
 * function HeavyComponent() {
 *   const isReady = useAfterInteractions();
 *
 *   if (!isReady) {
 *     return <Skeleton />;
 *   }
 *
 *   return <ExpensiveRender />;
 * }
 */
export function useAfterInteractions(): boolean {
  const [isReady, setIsReady] = React.useState(false);

  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      setIsReady(true);
    });

    return () => task.cancel();
  }, []);

  return isReady;
}

/**
 * Memoization helper for expensive computations
 * Similar to useMemo but with better debugging
 */
export function useMemoDebug<T>(
  factory: () => T,
  deps: React.DependencyList,
  debugName?: string
): T {
  const prevDeps = useRef<React.DependencyList>();

  const value = useMemo(() => {
    if (__DEV__ && debugName) {
      console.log(`[Memo] Computing ${debugName}`);
    }
    return factory();
  }, deps);

  useEffect(() => {
    if (__DEV__ && debugName && prevDeps.current) {
      const changedDeps = deps
        .map((dep, i) => (dep !== prevDeps.current![i] ? i : -1))
        .filter((i) => i !== -1);

      if (changedDeps.length > 0) {
        console.log(`[Memo] ${debugName} recomputed due to deps:`, changedDeps);
      }
    }
    prevDeps.current = deps;
  });

  return value;
}

/**
 * Stable callback that doesn't change between renders
 * Prevents unnecessary re-renders of child components
 */
export function useStableCallback<T extends (...args: any[]) => any>(
  callback: T
): T {
  const callbackRef = useRef(callback);

  useEffect(() => {
    callbackRef.current = callback;
  });

  return useCallback(
    ((...args: any[]) => callbackRef.current(...args)) as T,
    []
  );
}

/**
 * FlatList optimization props
 * Use these for smooth scrolling with large lists
 */
export const FLATLIST_OPTIMIZATIONS = {
  // Don't re-render items unless data actually changed
  removeClippedSubviews: true,

  // Adjust window size for better performance
  windowSize: 10, // WhatsApp/Telegram use ~10

  // Adjust initial render
  initialNumToRender: 10,

  // Batch updates
  maxToRenderPerBatch: 10,
  updateCellsBatchingPeriod: 50,

  // Better key extractor performance
  keyExtractor: (item: any, index: number) => item.id?.toString() || index.toString(),

  // Render optimization
  getItemLayout: undefined, // Provide if all items have same height
};

/**
 * Get FlatList getItemLayout for fixed-height items
 * Dramatically improves scroll performance
 *
 * @example
 * <FlatList
 *   data={items}
 *   getItemLayout={getItemLayout(ITEM_HEIGHT)}
 * />
 */
export function getItemLayout(itemHeight: number) {
  return (data: any, index: number) => ({
    length: itemHeight,
    offset: itemHeight * index,
    index,
  });
}

/**
 * React.memo with custom comparison
 * Prevents re-renders for specific props
 */
export function memoWithProps<P>(
  Component: React.ComponentType<P>,
  propsAreEqual?: (prevProps: Readonly<P>, nextProps: Readonly<P>) => boolean
): React.MemoExoticComponent<React.ComponentType<P>> {
  return React.memo(Component, propsAreEqual);
}

/**
 * Shallow comparison for React.memo
 * Faster than deep comparison
 */
export function shallowEqual(objA: any, objB: any): boolean {
  if (Object.is(objA, objB)) {
    return true;
  }

  if (
    typeof objA !== 'object' ||
    objA === null ||
    typeof objB !== 'object' ||
    objB === null
  ) {
    return false;
  }

  const keysA = Object.keys(objA);
  const keysB = Object.keys(objB);

  if (keysA.length !== keysB.length) {
    return false;
  }

  for (let i = 0; i < keysA.length; i++) {
    if (
      !Object.prototype.hasOwnProperty.call(objB, keysA[i]) ||
      !Object.is(objA[keysA[i]], objB[keysA[i]])
    ) {
      return false;
    }
  }

  return true;
}

/**
 * Request animation frame wrapper
 * Use for smooth animations
 */
export function useRAF(callback: () => void, deps: React.DependencyList): void {
  useEffect(() => {
    const id = requestAnimationFrame(callback);
    return () => cancelAnimationFrame(id);
  }, deps);
}

/**
 * Intersection observer hook for lazy loading
 * Load content only when visible
 */
export function useIntersection(
  ref: React.RefObject<any>,
  options?: IntersectionObserverInit
): boolean {
  const [isIntersecting, setIsIntersecting] = React.useState(false);

  useEffect(() => {
    if (!ref.current) return;

    const observer = new IntersectionObserver(([entry]) => {
      setIsIntersecting(entry.isIntersecting);
    }, options);

    observer.observe(ref.current);

    return () => {
      observer.disconnect();
    };
  }, [ref, options]);

  return isIntersecting;
}
