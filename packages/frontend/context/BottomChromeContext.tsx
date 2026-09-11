import { createContext, useContext, useMemo, type PropsWithChildren } from 'react';
import { useTabBarFootprint } from '@oxy.so/bloom/tab-bar';

const CONTENT_GAP = 12;

interface BottomChromeState {
  visible: boolean;
  contentClearance: number;
}

const BottomChromeContext = createContext<BottomChromeState | null>(null);

interface BottomChromeProviderProps extends PropsWithChildren {
  visible: boolean;
}

export function BottomChromeProvider({ children, visible }: BottomChromeProviderProps) {
  const footprint = useTabBarFootprint();
  const value = useMemo(
    () => ({
      visible,
      contentClearance: visible ? footprint + CONTENT_GAP : 0,
    }),
    [footprint, visible],
  );

  return <BottomChromeContext.Provider value={value}>{children}</BottomChromeContext.Provider>;
}

export function useBottomChrome(): BottomChromeState {
  const state = useContext(BottomChromeContext);
  if (state === null) throw new Error('useBottomChrome must be used inside BottomChromeProvider');
  return state;
}
