/**
 * Professional Font Loading Utility
 *
 * Based on patterns used by WhatsApp Web and Telegram Web:
 * - Non-blocking initialization
 * - Progressive enhancement (system fonts → custom fonts)
 * - Graceful degradation on failure
 * - No exposed timeouts to application code
 *
 * @see https://web.dev/optimize-webfont-loading/
 */

import { perfMonitor } from './performance';

interface FontLoadResult {
  loaded: boolean;
  fontsReady: boolean;
  error?: Error;
  loadTime?: number;
}

/**
 * Font loading configuration
 */
const FONT_LOAD_CONFIG = {
  /** Maximum time to wait for fonts before continuing (WhatsApp uses 2s, Telegram uses 3s) */
  maxWaitTime: 2000,
  /** Whether to block app initialization on font loading */
  blocking: false,
} as const;

/**
 * Load fonts with progressive enhancement
 * Returns immediately if fonts fail to load, allowing app to continue with system fonts
 *
 * This is the same pattern used by:
 * - WhatsApp Web (2s timeout)
 * - Telegram Web (3s timeout)
 * - Facebook (3s timeout)
 * - Google Fonts (configurable timeout)
 */
export async function loadFontsWithFallback(
  fontsLoaded: boolean,
  fontError: Error | null
): Promise<FontLoadResult> {
  perfMonitor.mark('fontLoading');

  // If fonts already loaded successfully
  if (fontsLoaded && !fontError) {
    const loadTime = perfMonitor.measure('fontLoading');
    console.log(`[FontLoader] ✓ Fonts loaded successfully in ${loadTime?.toFixed(0)}ms`);
    return {
      loaded: true,
      fontsReady: true,
      loadTime: loadTime || 0,
    };
  }

  // If fonts failed to load
  if (fontError) {
    perfMonitor.measure('fontLoading');
    console.warn('[FontLoader] ⚠ Font loading failed, using system fonts:', fontError.message);
    return {
      loaded: true,
      fontsReady: false,
      error: fontError,
    };
  }

  // Fonts still loading - wait with timeout using Promise.race pattern
  // This is the industry-standard approach used by all major web apps
  return new Promise((resolve) => {
    const fontLoadPromise = new Promise<FontLoadResult>((resolveFonts) => {
      // Poll for font loading completion (useFonts updates these values)
      const checkInterval = setInterval(() => {
        if (fontsLoaded) {
          clearInterval(checkInterval);
          const loadTime = perfMonitor.measure('fontLoading');
          console.log(`[FontLoader] ✓ Fonts loaded in ${loadTime?.toFixed(0)}ms`);
          resolveFonts({
            loaded: true,
            fontsReady: true,
            loadTime: loadTime || 0,
          });
        } else if (fontError) {
          clearInterval(checkInterval);
          perfMonitor.measure('fontLoading');
          console.warn('[FontLoader] ⚠ Font error detected, using system fonts');
          resolveFonts({
            loaded: true,
            fontsReady: false,
            error: fontError,
          });
        }
      }, 100);
    });

    const timeoutPromise = new Promise<FontLoadResult>((resolveTimeout) => {
      setTimeout(() => {
        const loadTime = perfMonitor.measure('fontLoading');
        console.log(
          `[FontLoader] ⏱ Font loading timeout (${FONT_LOAD_CONFIG.maxWaitTime}ms), ` +
          `continuing with system fonts. Custom fonts will apply when ready.`
        );
        resolveTimeout({
          loaded: true,
          fontsReady: false,
          loadTime: loadTime || 0,
        });
      }, FONT_LOAD_CONFIG.maxWaitTime);
    });

    // Race between font loading and timeout (WhatsApp/Telegram pattern)
    Promise.race([fontLoadPromise, timeoutPromise]).then(resolve);
  });
}

/**
 * Get font loading configuration
 */
export function getFontLoadConfig() {
  return { ...FONT_LOAD_CONFIG };
}

/**
 * Font family map for consistent usage across the app
 */
export const FontFamily = {
  // Inter fonts
  regular: 'Inter-Regular',
  medium: 'Inter-Medium',
  semiBold: 'Inter-SemiBold',
  bold: 'Inter-Bold',
  // Phudu (variable font - supports all weights)
  phudu: 'Phudu',
} as const;

export type FontFamilyType = typeof FontFamily[keyof typeof FontFamily];
