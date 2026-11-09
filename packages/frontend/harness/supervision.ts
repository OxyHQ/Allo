/** Local ALLO_HARNESS fixture only. No production resolver imports this module. */
import { useSyncExternalStore } from 'react';
export type HarnessPolicy = 'allowed' | 'blocked' | 'unavailable';
let policy: HarnessPolicy = 'allowed';
const listeners = new Set<() => void>();
const search = typeof window !== 'undefined' ? window.location?.search : undefined;
export const supervisedHarness =
  typeof search === 'string' && new URLSearchParams(search).has('harnessSupervised');
export const harnessPolicy = () => policy;
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function')
  window.addEventListener('allo:harness-policy', (event) => {
    const value = (event as CustomEvent<unknown>).detail;
    if (value !== 'allowed' && value !== 'blocked' && value !== 'unavailable')
      throw new Error('Unknown harness policy');
    policy = value;
    for (const listener of listeners) listener();
  });
export function useSupervision() {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    harnessPolicy,
    harnessPolicy,
  );
  return {
    data: { self: supervisedHarness ? { status: 'active' } : null },
    isError: false,
    refetch: async () => undefined,
  };
}
