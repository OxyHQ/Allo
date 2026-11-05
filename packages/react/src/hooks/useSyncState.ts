import type { SyncState } from '@allo/core';
import { useAlloContext } from '../AlloProvider';
import { useClientSnapshot } from '../internal/useClientSnapshot';

/** `idle | syncing | live | offline | error`. Subscribes to `sync`. */
export function useSyncState(): SyncState {
  const { client } = useAlloContext();
  return useClientSnapshot(client, 'sync', () => client.sync.state());
}

/**
 * Whether a sync has completed since the client started. A list that is empty
 * before this is still loading, not empty. Subscribes to `sync`.
 */
export function useSynced(): boolean {
  const { client } = useAlloContext();
  return useClientSnapshot(client, 'sync', () => client.sync.synced());
}
