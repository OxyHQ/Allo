/**
 * Performance Monitoring Utilities
 * Lightweight performance tracking for production
 */

interface PerformanceMark {
  name: string;
  startTime: number;
  duration?: number;
}

class PerformanceMonitor {
  private marks: Map<string, number> = new Map();
  private measurements: PerformanceMark[] = [];
  private enabled: boolean;

  constructor() {
    // Only enable in development or when explicitly enabled
    this.enabled = __DEV__ || false;
  }

  /**
   * Start measuring a performance metric
   */
  mark(name: string): void {
    if (!this.enabled) return;
    this.marks.set(name, performance.now());
  }

  /**
   * End measuring and record the duration
   */
  measure(name: string): number | null {
    if (!this.enabled) return null;

    const startTime = this.marks.get(name);
    if (!startTime) {
      console.warn(`[Performance] No mark found for: ${name}`);
      return null;
    }

    const duration = performance.now() - startTime;
    this.measurements.push({ name, startTime, duration });
    this.marks.delete(name);

    return duration;
  }

  /**
   * Measure and log a performance metric
   */
  measureAndLog(name: string, threshold?: number): void {
    const duration = this.measure(name);
    if (duration !== null) {
      if (threshold && duration > threshold) {
        console.warn(`[Performance] ${name} took ${duration.toFixed(2)}ms (threshold: ${threshold}ms)`);
      } else {
        console.log(`[Performance] ${name} took ${duration.toFixed(2)}ms`);
      }
    }
  }

  /**
   * Get all measurements
   */
  getMeasurements(): PerformanceMark[] {
    return [...this.measurements];
  }

  /**
   * Clear all measurements
   */
  clear(): void {
    this.marks.clear();
    this.measurements = [];
  }

  /**
   * Get average duration for a specific metric
   */
  getAverage(name: string): number | null {
    const filtered = this.measurements.filter(m => m.name === name && m.duration);
    if (filtered.length === 0) return null;

    const sum = filtered.reduce((acc, m) => acc + (m.duration || 0), 0);
    return sum / filtered.length;
  }

  /**
   * Enable or disable monitoring
   */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }
}

// Singleton instance
export const perfMonitor = new PerformanceMonitor();

/**
 * Measure API call performance
 */
export async function measureApiCall<T>(
  name: string,
  apiCall: () => Promise<T>
): Promise<T> {
  perfMonitor.mark(name);
  try {
    const result = await apiCall();
    perfMonitor.measureAndLog(name, 1000); // Warn if > 1s
    return result;
  } catch (error) {
    perfMonitor.measure(name);
    throw error;
  }
}

/**
 * Measure render time
 */
export function measureRender<T>(
  name: string,
  renderFn: () => T
): T {
  perfMonitor.mark(name);
  const result = renderFn();
  perfMonitor.measureAndLog(name, 16); // Warn if > 16ms (60fps threshold)
  return result;
}

/**
 * Track long tasks (blocking operations)
 */
export function trackLongTask(callback: () => void, taskName: string): void {
  const start = performance.now();
  callback();
  const duration = performance.now() - start;

  if (duration > 50) {
    console.warn(`[Performance] Long task detected: ${taskName} took ${duration.toFixed(2)}ms`);
  }
}

/**
 * Memory usage tracker (Node.js only)
 */
export function logMemoryUsage(): void {
  if (typeof process !== 'undefined' && process.memoryUsage) {
    const usage = process.memoryUsage();
    console.log('[Performance] Memory usage:', {
      rss: `${(usage.rss / 1024 / 1024).toFixed(2)} MB`,
      heapUsed: `${(usage.heapUsed / 1024 / 1024).toFixed(2)} MB`,
      heapTotal: `${(usage.heapTotal / 1024 / 1024).toFixed(2)} MB`,
    });
  }
}

/**
 * FPS monitor for animations
 */
export class FPSMonitor {
  private frames: number[] = [];
  private lastTime: number = performance.now();
  private rafId: number | null = null;

  start(): void {
    const measure = () => {
      const now = performance.now();
      const delta = now - this.lastTime;
      const fps = 1000 / delta;

      this.frames.push(fps);
      if (this.frames.length > 60) {
        this.frames.shift();
      }

      this.lastTime = now;
      this.rafId = requestAnimationFrame(measure);
    };

    this.rafId = requestAnimationFrame(measure);
  }

  stop(): void {
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }

  getAverageFPS(): number {
    if (this.frames.length === 0) return 0;
    const sum = this.frames.reduce((a, b) => a + b, 0);
    return sum / this.frames.length;
  }

  getCurrentFPS(): number {
    return this.frames[this.frames.length - 1] || 0;
  }
}

// Export types
export type { PerformanceMark };
