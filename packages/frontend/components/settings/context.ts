import { createContext, useContext } from 'react';

export interface AlloSettingsControl {
  open: (page?: string) => void;
  close: (afterClose?: () => void) => void;
  setPhrasePending: (pending: boolean) => void;
}
export const AlloSettingsContext = createContext<AlloSettingsControl | null>(null);
export function useAlloSettings() {
  const value = useContext(AlloSettingsContext);
  if (!value) throw new Error('AlloSettingsProvider is missing');
  return value;
}
