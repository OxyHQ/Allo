/**
 * Responsive breakpoint constants
 * Used consistently across the application for responsive layouts
 */

export const BREAKPOINTS = {
  MOBILE: 768,
  TABLET: 768,
  DESKTOP: 1024,
  XL_DESKTOP: 1280,
} as const;

/**
 * Screen size categories
 */
export type ScreenSize = 'mobile' | 'tablet' | 'desktop' | 'xl-desktop';

/**
 * Helper to determine screen size category
 */
export const getScreenSize = (width: number): ScreenSize => {
  if (width >= BREAKPOINTS.XL_DESKTOP) return 'xl-desktop';
  if (width >= BREAKPOINTS.DESKTOP) return 'desktop';
  if (width >= BREAKPOINTS.TABLET) return 'tablet';
  return 'mobile';
};

