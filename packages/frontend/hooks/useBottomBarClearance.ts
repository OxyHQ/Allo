import { useTabBarFootprint } from '@oxy.so/bloom/tab-bar';

import { useIsScreenNotMobile } from '@/hooks/useOptimizedMediaQuery';

const CONTENT_GAP = 12;

/** Space occupied by Allo's floating navigation plus scroll-content breathing room. */
export function useBottomBarClearance(): number {
  const footprint = useTabBarFootprint();
  const isScreenNotMobile = useIsScreenNotMobile();
  return isScreenNotMobile ? 0 : footprint + CONTENT_GAP;
}
