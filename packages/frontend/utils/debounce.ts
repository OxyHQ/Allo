/**
 * Debounce Utilities
 * High-performance debouncing for expensive operations
 */

/**
 * Creates a debounced function that delays invoking func until after wait milliseconds
 * have elapsed since the last time the debounced function was invoked.
 *
 * @param func The function to debounce
 * @param wait The number of milliseconds to delay
 * @param options.leading Execute on the leading edge of the timeout
 * @param options.trailing Execute on the trailing edge of the timeout
 * @returns Debounced function with cancel method
 *
 * @example
 * const debouncedSearch = debounce((query: string) => {
 *   api.search(query);
 * }, 300);
 *
 * // Usage
 * debouncedSearch('hello'); // Will only execute after 300ms of no calls
 * debouncedSearch.cancel(); // Cancel pending execution
 */
export function debounce<T extends (...args: any[]) => any>(
  func: T,
  wait: number,
  options: { leading?: boolean; trailing?: boolean } = { trailing: true }
): T & { cancel: () => void; flush: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;
  let result: any;

  const { leading = false, trailing = true } = options;

  function invokeFunc() {
    if (lastArgs && lastThis) {
      result = func.apply(lastThis, lastArgs);
      lastArgs = null;
      lastThis = null;
    }
  }

  function cancel() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
    lastArgs = null;
    lastThis = null;
  }

  function flush() {
    if (timeoutId !== null) {
      cancel();
      invokeFunc();
    }
    return result;
  }

  function debounced(this: any, ...args: any[]) {
    lastArgs = args;
    lastThis = this;

    if (timeoutId !== null) {
      clearTimeout(timeoutId);
    }

    if (leading && timeoutId === null) {
      invokeFunc();
    }

    timeoutId = setTimeout(() => {
      if (trailing) {
        invokeFunc();
      }
      timeoutId = null;
    }, wait);

    return result;
  }

  debounced.cancel = cancel;
  debounced.flush = flush;

  return debounced as T & { cancel: () => void; flush: () => void };
}

/**
 * Creates a throttled function that only invokes func at most once per every wait milliseconds.
 *
 * @param func The function to throttle
 * @param wait The number of milliseconds to throttle invocations to
 * @returns Throttled function with cancel method
 *
 * @example
 * const throttledScroll = throttle((event) => {
 *   console.log('Scroll position:', event.scrollY);
 * }, 100);
 *
 * window.addEventListener('scroll', throttledScroll);
 */
export function throttle<T extends (...args: any[]) => any>(
  func: T,
  wait: number
): T & { cancel: () => void } {
  let timeoutId: NodeJS.Timeout | null = null;
  let lastRan: number = 0;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  function cancel() {
    if (timeoutId !== null) {
      clearTimeout(timeoutId);
      timeoutId = null;
    }
  }

  function throttled(this: any, ...args: any[]) {
    const now = Date.now();
    lastArgs = args;
    lastThis = this;

    if (!lastRan) {
      func.apply(this, args);
      lastRan = now;
    } else {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }

      timeoutId = setTimeout(() => {
        if (Date.now() - lastRan >= wait && lastArgs && lastThis) {
          func.apply(lastThis, lastArgs);
          lastRan = Date.now();
        }
      }, wait - (now - lastRan));
    }
  }

  throttled.cancel = cancel;

  return throttled as T & { cancel: () => void };
}

/**
 * Request Animation Frame based debounce for visual updates
 * More efficient than setTimeout for UI updates
 *
 * @param func The function to debounce
 * @returns Debounced function with cancel method
 *
 * @example
 * const debouncedUpdate = rafDebounce(() => {
 *   updateUI();
 * });
 */
export function rafDebounce<T extends (...args: any[]) => any>(
  func: T
): T & { cancel: () => void } {
  let rafId: number | null = null;
  let lastArgs: any[] | null = null;
  let lastThis: any = null;

  function cancel() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastArgs = null;
    lastThis = null;
  }

  function debounced(this: any, ...args: any[]) {
    lastArgs = args;
    lastThis = this;

    if (rafId !== null) {
      cancelAnimationFrame(rafId);
    }

    rafId = requestAnimationFrame(() => {
      if (lastArgs && lastThis) {
        func.apply(lastThis, lastArgs);
      }
      rafId = null;
      lastArgs = null;
      lastThis = null;
    });
  }

  debounced.cancel = cancel;

  return debounced as T & { cancel: () => void };
}
