/**
 * Session persistence for the Double Ratchet.
 *
 * A session is keyed by a logical peer address `${userId}.${deviceId}`. Sessions
 * are stored in secureStorage (Expo SecureStore on native, AsyncStorage on web)
 * as base64-encoded JSON. To avoid hitting secure-storage size limits with the
 * skipped-keys cache, we also expose an in-memory cache that is hydrated on first
 * use.
 */

import { getSecureItem, setSecureItem, removeSecureItem } from '@/lib/secureStorage';
import { Storage } from '@/utils/storage';
import {
  RatchetState,
  SerializedRatchetState,
  serializeRatchet,
  deserializeRatchet,
} from './doubleRatchet';

const SESSION_KEY_PREFIX = 'signal_session_v2_';

/**
 * Registry of all live session storage keys, persisted in regular storage.
 *
 * SecureStore (native) exposes no "list keys" API, so to be able to wipe EVERY
 * session on device revocation we keep an explicit index of the session keys we
 * have written. The index holds only key NAMES (e.g.
 * `signal_session_v2_<user>_<deviceId>`) — these are non-secret addresses, never
 * key material — so storing them outside SecureStore is safe.
 */
const SESSION_KEY_INDEX = 'signal_session_v2_index';

export interface PeerAddress {
  userId: string;
  deviceId: number;
}

function storageKey(addr: PeerAddress): string {
  // SecureStore keys are restricted to alphanumeric + ._- on iOS, so sanitize.
  const safeUser = addr.userId.replace(/[^A-Za-z0-9._-]/g, '_');
  return `${SESSION_KEY_PREFIX}${safeUser}_${addr.deviceId}`;
}

const memoryCache = new Map<string, RatchetState>();

/** Read the persisted set of session storage keys. */
async function readSessionKeyIndex(): Promise<Set<string>> {
  const keys = await Storage.get<string[]>(SESSION_KEY_INDEX);
  return new Set(Array.isArray(keys) ? keys : []);
}

/** Record a session storage key in the persisted index (idempotent). */
async function trackSessionKey(key: string): Promise<void> {
  const index = await readSessionKeyIndex();
  if (index.has(key)) return;
  index.add(key);
  await Storage.set(SESSION_KEY_INDEX, Array.from(index));
}

/** Remove a session storage key from the persisted index. */
async function untrackSessionKey(key: string): Promise<void> {
  const index = await readSessionKeyIndex();
  if (!index.delete(key)) return;
  await Storage.set(SESSION_KEY_INDEX, Array.from(index));
}

export async function loadSession(addr: PeerAddress): Promise<RatchetState | null> {
  const key = storageKey(addr);
  const cached = memoryCache.get(key);
  if (cached) return cached;

  const raw = await getSecureItem(key);
  if (!raw) return null;

  try {
    const data = JSON.parse(raw) as SerializedRatchetState;
    const state = deserializeRatchet(data);
    memoryCache.set(key, state);
    // Self-heal the key index: sessions written before the index existed (or by
    // an older build) are not tracked, so `wipeAllSessions` would miss them and
    // a stale ratchet could be resurrected after a re-init. Recording the key on
    // first load brings legacy sessions under the index over time, making them
    // wipeable. `trackSessionKey` is idempotent. Fire-and-forget so a slow index
    // write never delays returning the session.
    void trackSessionKey(key).catch((error) =>
      console.warn('[SignalSession] Failed to index session key on load', error)
    );
    return state;
  } catch (error) {
    console.error('[SignalSession] Failed to parse session for', addr, error);
    return null;
  }
}

export async function saveSession(addr: PeerAddress, state: RatchetState): Promise<void> {
  const key = storageKey(addr);
  memoryCache.set(key, state);
  const serialized = JSON.stringify(serializeRatchet(state));
  await setSecureItem(key, serialized);
  await trackSessionKey(key);
}

export async function deleteSession(addr: PeerAddress): Promise<void> {
  const key = storageKey(addr);
  memoryCache.delete(key);
  await removeSecureItem(key);
  await untrackSessionKey(key);
}

export function clearSessionMemoryCache(): void {
  memoryCache.clear();
}

/**
 * Delete EVERY persisted Double Ratchet session and clear the in-memory cache.
 *
 * Used when this device is revoked: all sessions were keyed to the old device
 * identity and must be discarded before re-initializing as a new device. Uses
 * the persisted key index (every key written by `saveSession`, plus any legacy
 * key self-healed into the index by `loadSession`) so it works on native
 * SecureStore, which cannot enumerate keys on its own.
 *
 * Residual limitation: a pre-index session that has NEVER been loaded since the
 * index was introduced is not in the index and cannot be located on native
 * SecureStore (no enumerate API), so it would survive this wipe. In practice it
 * becomes wipeable the first time `loadSession` touches it, and after re-init the
 * device identity differs so any orphan can no longer establish a valid session.
 * On web/AsyncStorage every session is reachable; this gap is native-only and
 * shrinks to zero as sessions are exercised. The in-memory cache is cleared
 * unconditionally so no decrypted ratchet state lingers in this process.
 */
export async function wipeAllSessions(): Promise<void> {
  const index = await readSessionKeyIndex();
  await Promise.all(Array.from(index).map((key) => removeSecureItem(key)));
  await Storage.remove(SESSION_KEY_INDEX);
  memoryCache.clear();
}
