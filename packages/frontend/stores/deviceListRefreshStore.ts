/**
 * Device-list refresh signal.
 *
 * A tiny store holding a monotonically increasing revision. The realtime
 * `deviceListChanged` socket event bumps it; the Linked Devices screen
 * subscribes to it so it re-fetches `GET /api/devices` when the owner's device
 * list changes elsewhere (a device linked or revoked on another device).
 *
 * Kept separate from `deviceKeysStore` so bumping the signal never re-renders
 * the many components subscribed to device-keys state.
 */

import { create } from 'zustand';

interface DeviceListRefreshState {
  /** Increments whenever the device list should be re-fetched. */
  revision: number;
  /** Bump the revision to signal subscribers to refresh. */
  bump: () => void;
}

export const useDeviceListRefreshStore = create<DeviceListRefreshState>((set) => ({
  revision: 0,
  bump: () => set((state) => ({ revision: state.revision + 1 })),
}));

/** Module-level bump usable from non-React contexts (e.g. socket handlers). */
export function bumpDeviceListRefresh(): void {
  useDeviceListRefreshStore.getState().bump();
}
