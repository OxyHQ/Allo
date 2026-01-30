import NetInfo, { NetInfoState } from '@react-native-community/netinfo';
import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';

/**
 * Connection Status Manager
 *
 * WhatsApp/Telegram-level: Real-time connection monitoring
 * Provides offline detection, queue management, and automatic retry
 */

export type ConnectionStatus = 'online' | 'offline' | 'reconnecting';

interface ConnectionStatusState {
  status: ConnectionStatus;
  isConnected: boolean;
  connectionType: string | null;
  lastOnlineTime: number;
  lastOfflineTime: number;
  reconnectAttempts: number;

  // Actions
  setStatus: (status: ConnectionStatus) => void;
  setConnectionInfo: (info: Partial<NetInfoState>) => void;
  incrementReconnectAttempts: () => void;
  resetReconnectAttempts: () => void;
}

export const useConnectionStatusStore = create<ConnectionStatusState>()(
  subscribeWithSelector((set, get) => ({
    status: 'online',
    isConnected: true,
    connectionType: null,
    lastOnlineTime: Date.now(),
    lastOfflineTime: 0,
    reconnectAttempts: 0,

    setStatus: (status) => {
      const prev = get().status;
      set({ status });

      // Track time
      if (status === 'online' && prev !== 'online') {
        set({ lastOnlineTime: Date.now(), reconnectAttempts: 0 });
      } else if (status === 'offline' && prev !== 'offline') {
        set({ lastOfflineTime: Date.now() });
      }
    },

    setConnectionInfo: (info) => {
      const isConnected = info.isConnected ?? true;
      const connectionType = info.type ?? null;

      set({
        isConnected,
        connectionType,
      });

      // Update status based on connection
      if (isConnected && get().status !== 'online') {
        get().setStatus('online');
      } else if (!isConnected && get().status !== 'offline') {
        get().setStatus('offline');
      }
    },

    incrementReconnectAttempts: () => {
      set((state) => ({ reconnectAttempts: state.reconnectAttempts + 1 }));
    },

    resetReconnectAttempts: () => {
      set({ reconnectAttempts: 0 });
    },
  }))
);

/**
 * Connection Event Listener
 * Subscribes to network changes and updates store
 */
let unsubscribe: (() => void) | null = null;

export function startConnectionMonitoring(): () => void {
  if (unsubscribe) {
    console.warn('[Connection] Already monitoring connection status');
    return unsubscribe;
  }

  console.log('[Connection] Starting connection monitoring');

  // Subscribe to NetInfo changes
  unsubscribe = NetInfo.addEventListener((state) => {
    const store = useConnectionStatusStore.getState();

    console.log('[Connection] Network state changed:', {
      isConnected: state.isConnected,
      type: state.type,
      isInternetReachable: state.isInternetReachable,
    });

    store.setConnectionInfo({
      isConnected: state.isConnected ?? false,
      type: state.type,
    });
  });

  // Initial state check
  NetInfo.fetch().then((state) => {
    const store = useConnectionStatusStore.getState();
    store.setConnectionInfo({
      isConnected: state.isConnected ?? false,
      type: state.type,
    });
  });

  return () => {
    if (unsubscribe) {
      console.log('[Connection] Stopping connection monitoring');
      unsubscribe();
      unsubscribe = null;
    }
  };
}

export function stopConnectionMonitoring(): void {
  if (unsubscribe) {
    unsubscribe();
    unsubscribe = null;
  }
}

/**
 * Connection Quality Detection
 * Detects slow connections (2G, 3G) vs fast (4G, 5G, WiFi)
 */
export function getConnectionQuality(
  connectionType: string | null
): 'fast' | 'slow' | 'offline' {
  if (!connectionType || connectionType === 'none' || connectionType === 'unknown') {
    return 'offline';
  }

  const slowConnections = ['cellular', '2g', '3g'];
  const fastConnections = ['wifi', '4g', '5g', 'ethernet'];

  if (slowConnections.includes(connectionType.toLowerCase())) {
    return 'slow';
  }

  if (fastConnections.includes(connectionType.toLowerCase())) {
    return 'fast';
  }

  // Default to slow for unknown types
  return 'slow';
}

/**
 * Wait for connection to be online
 * Returns immediately if already online
 */
export async function waitForConnection(timeoutMs: number = 30000): Promise<boolean> {
  const store = useConnectionStatusStore.getState();

  if (store.isConnected) {
    return true;
  }

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      unsubscribeStore();
      resolve(false);
    }, timeoutMs);

    const unsubscribeStore = useConnectionStatusStore.subscribe(
      (state) => state.isConnected,
      (isConnected) => {
        if (isConnected) {
          clearTimeout(timeout);
          unsubscribeStore();
          resolve(true);
        }
      }
    );
  });
}

/**
 * Exponential backoff for reconnection attempts
 */
export function getReconnectDelay(attempt: number): number {
  // Exponential backoff: 1s, 2s, 4s, 8s, 16s, max 30s
  const delay = Math.min(1000 * Math.pow(2, attempt), 30000);

  // Add jitter (±20%)
  const jitter = delay * 0.2 * (Math.random() * 2 - 1);

  return Math.max(delay + jitter, 1000);
}
