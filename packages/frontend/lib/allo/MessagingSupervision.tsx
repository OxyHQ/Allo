import { createContext, useContext } from 'react';

/** Resolved by the canonical Oxy hook at the app boundary, never persisted. */
export const MessagingSupervisionContext = createContext(false);
export function useMessagingSupervision(): boolean {
  return useContext(MessagingSupervisionContext);
}
