import type { ReactNode } from 'react';
import { Platform, View } from 'react-native';
import { useBottomEdgeInset } from '@oxy.so/bloom/layout';

/**
 * A screen's floating action, placed where Bloom 6 expects the parent to put it:
 * bottom-right, above the shell's measured bottom navigation. Bloom 6 removed
 * the FAB's own `placement`; Screen/BottomBar own placement now. Same shape as
 * Mention's `components/shell/PageAction.tsx`.
 */
export function PageAction({ children }: { children: ReactNode }) {
  const bottom = useBottomEdgeInset() + 16;
  return (
    <View
      className="self-end web:sticky native:absolute native:right-4 web:mr-4 web:mt-auto"
      style={{ bottom, ...(Platform.OS === 'web' ? { marginBottom: bottom } : {}) }}
    >
      {children}
    </View>
  );
}
