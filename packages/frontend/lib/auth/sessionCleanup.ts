/**
 * Centralized session cleanup.
 *
 * Runs when a user logs out or switches accounts. Order matters: sever live
 * connections first, then drop in-memory state, then purge on-device caches,
 * then clear the server-state cache. This guarantees no socket can repopulate a
 * store after it's been reset, and no plaintext data survives the transition.
 */
import type { QueryClient } from '@tanstack/react-query';

import { disconnectMessagingSocket } from '@/hooks/useRealtimeMessaging';
import { disconnectCallSignalingSocket } from '@/hooks/useCallSignaling';
import { disconnectP2PSocket } from '@/hooks/useP2PMessaging';

import { useConversationsStore } from '@/stores/conversationsStore';
import { useMessagesStore } from '@/stores/messagesStore';
import { useChatUIStore } from '@/stores/chatUIStore';
import { useCallsStore } from '@/stores/callsStore';
import { useStatusStore } from '@/stores/statusStore';
import { useUsersStore } from '@/stores/usersStore';
import { useDeviceKeysStore } from '@/stores/deviceKeysStore';
import { usePresenceStore } from '@/stores/presenceStore';

import { clearAllOfflineData } from '@/lib/offlineStorage';
import { clearDecryptedMediaCache } from '@/lib/mediaCache';

/**
 * Fully tear down the current user's session-scoped client state.
 *
 * Device-level preferences (appearance, swipe/message preferences) and the
 * persisted Signal key material in SecureStore are intentionally preserved —
 * see the individual store/`clearAllOfflineData` docs for the rationale.
 */
export async function cleanupUserSession(queryClient: QueryClient): Promise<void> {
  // 1. Sever all live realtime connections so nothing can repopulate the
  //    stores we're about to reset.
  disconnectMessagingSocket();
  disconnectCallSignalingSocket();
  disconnectP2PSocket();

  // 2. Reset all session-scoped in-memory stores.
  useConversationsStore.getState().reset();
  useMessagesStore.getState().reset();
  useChatUIStore.getState().reset();
  useCallsStore.getState().reset();
  useStatusStore.getState().reset();
  useUsersStore.getState().clearAll();
  // In-memory only — persisted device keys stay for same-account re-login.
  useDeviceKeysStore.getState().reset();
  // Drop presence so one account's online dots never bleed into the next.
  usePresenceStore.getState().clearAll();

  // 3. Purge on-device plaintext caches (messages/conversations/sync queue) and
  //    the decrypted-media cache (revokes web object URLs + deletes native temp
  //    files), so no decrypted bytes survive the session.
  await clearAllOfflineData();
  clearDecryptedMediaCache();

  // 4. Drop all cached server state.
  queryClient.clear();
}
