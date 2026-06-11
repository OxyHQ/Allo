/**
 * Device Keys Store
 *
 * Manages Signal Protocol device keys, prekey publication and per-peer session
 * encryption (X3DH + Double Ratchet).
 *
 * Multi-device fan-out (encryption version 3): a single logical message is
 * encrypted once per recipient *device* (every active device of every
 * conversation participant plus the sender's own other devices). The sender's
 * current device is excluded — it authored the plaintext. See
 * `encryptForConversation`.
 */

import { Platform } from 'react-native';
import Constants from 'expo-constants';
import { create } from 'zustand';
import {
  initializeDeviceKeys,
  getDeviceKeys,
  DeviceKeys,
  PublicBundle,
  RemotePublicBundle,
  encryptForPeer,
  decryptFromPeer,
  remainingOneTimePreKeys,
  generateAndStoreNewPreKeys,
  wipeAllSignalState,
  PREKEY_LOW_THRESHOLD,
  LegacyMessageError,
} from '@/lib/signalProtocol';
import { loadSession } from '@/lib/signal/sessionStore';
import { api, setApiDeviceId } from '@/utils/api';
import type {
  DevicePublicInfo,
  DeviceTarget,
  MessageEnvelopeDTO,
} from '@allo/shared-types';

/** How long a per-user device list is cached before a refetch (ms). */
const DEVICE_LIST_TTL_MS = 5 * 60 * 1000;

/** Hard cap on targets per batch prekey request (mirrors the backend cap). */
const PREKEY_BATCH_MAX_TARGETS = 500;

/** Cache entry for one user's active device list. */
interface DeviceListCacheEntry {
  devices: DevicePublicInfo[];
  fetchedAt: number;
}

/** Single prekey bundle entry as returned by `/devices/prekeys/batch`. */
interface BatchPreKeyBundle {
  userId: string;
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: { keyId: number; publicKey: string; signature: string };
  registrationId: number;
  preKey: { keyId: number; publicKey: string } | null;
}

interface DeviceKeysState {
  // Device keys
  deviceKeys: DeviceKeys | null;
  isInitialized: boolean;
  isLoading: boolean;
  error: string | null;

  // Actions
  initialize: () => Promise<void>;
  registerDevice: () => Promise<boolean>;
  uploadPreKeys: (count?: number) => Promise<boolean>;
  ensurePreKeyStock: () => Promise<void>;
  getRecipientBundle: (userId: string, deviceId?: number) => Promise<RemotePublicBundle>;
  getDevicesForUsers: (userIds: string[]) => Promise<Map<string, DevicePublicInfo[]>>;
  invalidateDeviceCache: (userIds?: string[]) => void;
  encryptForConversation: (
    plaintext: string,
    participantUserIds: string[],
    ownUserId: string
  ) => Promise<{ envelopes: MessageEnvelopeDTO[]; failures: DeviceTarget[] }>;
  /** @internal Single-target encryption — retained for the P2P direct path. */
  encryptMessageForRecipient: (message: string, recipientUserId: string) => Promise<string>;
  decryptMessageFromSender: (
    ciphertext: string,
    senderUserId: string,
    senderDeviceId: number
  ) => Promise<string>;
  /**
   * Handle server-side revocation of THIS device (`device:revoked`): wipe all
   * persisted Signal state, reset in-memory state and re-initialize as a brand
   * new device (fresh keys + registration). Returns the new numeric device id on
   * success, or null if re-initialization failed.
   */
  handleRevocation: () => Promise<number | null>;
  reset: () => void;
}

/**
 * Module-level device-list cache. Kept outside the zustand state so that reading
 * it never triggers React re-renders — it is a pure network/IO cache.
 */
const deviceListCache = new Map<string, DeviceListCacheEntry>();

/**
 * In-flight session-ESTABLISHMENT locks, keyed `${userId}:${deviceId}`. Used so
 * that two concurrent fan-outs never run X3DH for the same session-less device
 * twice (which would consume two one-time prekeys and overwrite the first
 * session). Only establishment is serialized — steady-state encrypts proceed
 * concurrently. The entry is the establishing call's promise; it is deleted on
 * settle.
 */
const sessionEstablishLocks = new Map<string, Promise<void>>();

/**
 * In-flight revocation re-key, if any. Guards against repeated `device:revoked`
 * events triggering more than one concurrent wipe + re-initialize.
 */
let revocationInFlight: Promise<number | null> | null = null;

/** A deferred establishment lock: a promise plus its settle handles. */
interface EstablishLock {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

/** Create a deferred lock whose promise others can await. */
function createEstablishLock(): EstablishLock {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Avoid unhandled-rejection warnings: awaiters attach their own handlers.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Stable map key for a (user, device) pair. */
function targetKey(target: { userId: string; deviceId: number }): string {
  return `${target.userId}:${target.deviceId}`;
}

function buildPublicBundlePayload(keys: DeviceKeys): PublicBundle {
  return {
    deviceId: keys.deviceId,
    identityKeyPublic: keys.identityKeyPublic,
    signedPreKey: {
      keyId: keys.signedPreKey.keyId,
      publicKey: keys.signedPreKey.publicKey,
      signature: keys.signedPreKey.signature,
    },
    preKeys: keys.preKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
    registrationId: keys.registrationId,
  };
}

/** Map RN's runtime platform onto the stored device platform enum. */
function resolveDevicePlatform(): 'ios' | 'android' | 'web' {
  if (Platform.OS === 'ios') return 'ios';
  if (Platform.OS === 'android') return 'android';
  return 'web';
}

/**
 * Best-effort human-readable device name. Prefers Expo's `deviceName` (physical
 * device model / user-assigned name) and falls back to the app + platform so the
 * server always has something to show in device-management UIs. No new native
 * dependency is added — `expo-constants` is already part of the SDK set.
 */
function resolveDeviceName(): string {
  const fromConstants = typeof Constants.deviceName === 'string' ? Constants.deviceName.trim() : '';
  if (fromConstants.length > 0) return fromConstants;
  const appName =
    (typeof Constants.expoConfig?.name === 'string' && Constants.expoConfig.name) || 'Allo';
  return `${appName} (${resolveDevicePlatform()})`;
}

/**
 * Unwrap the backend success envelope. `sendSuccessResponse` wraps payloads as
 * `{ data: <payload> }`; tolerate a flat payload too for forward-compatibility.
 */
function unwrap<T>(body: unknown): T {
  if (body && typeof body === 'object' && 'data' in (body as Record<string, unknown>)) {
    return (body as { data: T }).data;
  }
  return body as T;
}

export const useDeviceKeysStore = create<DeviceKeysState>((set, get) => ({
  deviceKeys: null,
  isInitialized: false,
  isLoading: false,
  error: null,

  initialize: async () => {
    set({ isLoading: true, error: null });
    try {
      const keys = await initializeDeviceKeys();

      // Identify this device on every subsequent backend request so the server
      // hydrates this device's per-device envelopes (encryption version 3).
      setApiDeviceId(keys.deviceId);

      set({ deviceKeys: keys, isInitialized: true, isLoading: false });

      const registered = await get().registerDevice();
      if (!registered) {
        console.warn('[DeviceKeys] Device registration failed, but keys are initialized');
      }
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to initialize device keys';
      console.error('[DeviceKeys] Error initializing:', error);
      set({ error: errorMessage, isLoading: false, isInitialized: false });
      throw error;
    }
  },

  registerDevice: async () => {
    try {
      const keys = get().deviceKeys;
      if (!keys) throw new Error('Device keys not initialized');
      const payload = {
        ...buildPublicBundlePayload(keys),
        deviceName: resolveDeviceName(),
        platform: resolveDevicePlatform(),
      };
      await api.post('/devices', payload);
      return true;
    } catch (error) {
      console.error('[DeviceKeys] Error registering device:', error);
      return false;
    }
  },

  uploadPreKeys: async (count?: number) => {
    try {
      const keys = get().deviceKeys;
      if (!keys) throw new Error('Device keys not initialized');
      const fresh = await generateAndStoreNewPreKeys(count);
      if (fresh.length === 0) return true;
      await api.post(`/devices/${keys.deviceId}/prekeys`, { preKeys: fresh });
      // Refresh local state with the latest persisted keys.
      const refreshed = await getDeviceKeys();
      if (refreshed) set({ deviceKeys: refreshed });
      return true;
    } catch (error) {
      console.error('[DeviceKeys] Error uploading prekeys:', error);
      return false;
    }
  },

  ensurePreKeyStock: async () => {
    try {
      const remaining = await remainingOneTimePreKeys();
      if (remaining <= PREKEY_LOW_THRESHOLD) {
        await get().uploadPreKeys();
      }
    } catch (error) {
      console.warn('[DeviceKeys] ensurePreKeyStock failed:', error);
    }
  },

  getRecipientBundle: async (userId: string, deviceId?: number) => {
    let targetDeviceId = deviceId;
    if (!targetDeviceId) {
      const devices = (await get().getDevicesForUsers([userId])).get(userId) || [];
      if (devices.length === 0) {
        throw new Error('No devices found for user');
      }
      targetDeviceId = devices[0].deviceId;
    }

    const preKeysResponse = await api.get(
      `/devices/user/${userId}/prekeys/${targetDeviceId}`
    );
    const bundle = unwrap<RemotePublicBundle | undefined>(preKeysResponse.data);
    if (!bundle || !bundle.identityKeyPublic || !bundle.signedPreKey) {
      throw new Error('No prekey bundle available for user');
    }
    return bundle;
  },

  /**
   * Resolve the ACTIVE device list for each user, using a per-user in-memory TTL
   * cache. Users with a fresh cache entry are served locally; the rest are
   * fetched in parallel.
   */
  getDevicesForUsers: async (userIds: string[]) => {
    const now = Date.now();
    const result = new Map<string, DevicePublicInfo[]>();
    const toFetch: string[] = [];

    for (const userId of userIds) {
      const cached = deviceListCache.get(userId);
      if (cached && now - cached.fetchedAt < DEVICE_LIST_TTL_MS) {
        result.set(userId, cached.devices);
      } else if (!toFetch.includes(userId)) {
        toFetch.push(userId);
      }
    }

    if (toFetch.length > 0) {
      await Promise.all(
        toFetch.map(async (userId) => {
          try {
            const response = await api.get(`/devices/user/${userId}`);
            const payload = unwrap<{ devices?: DevicePublicInfo[] }>(response.data);
            const devices = payload.devices || [];
            deviceListCache.set(userId, { devices, fetchedAt: Date.now() });
            result.set(userId, devices);
          } catch (error) {
            console.warn(`[DeviceKeys] Failed to fetch devices for ${userId}:`, error);
            // Serve a stale entry if we have one rather than dropping the user.
            const stale = deviceListCache.get(userId);
            result.set(userId, stale ? stale.devices : []);
          }
        })
      );
    }

    return result;
  },

  invalidateDeviceCache: (userIds?: string[]) => {
    if (!userIds) {
      deviceListCache.clear();
      return;
    }
    for (const userId of userIds) {
      deviceListCache.delete(userId);
    }
  },

  encryptForConversation: async (plaintext, participantUserIds, ownUserId) => {
    const keys = get().deviceKeys;
    if (!keys) throw new Error('Device keys not initialized');
    const ownDeviceId = keys.deviceId;

    // Resolve every participant's active devices (own user included so we also
    // encrypt for the sender's OTHER devices — sent-message sync).
    const uniqueUserIds = Array.from(new Set([...participantUserIds, ownUserId]));
    const devicesByUser = await get().getDevicesForUsers(uniqueUserIds);

    // Build the fan-out target list: every active device MINUS our own current
    // device (it authored the plaintext and must NOT receive an envelope).
    const targets: DeviceTarget[] = [];
    for (const userId of uniqueUserIds) {
      const devices = devicesByUser.get(userId) || [];
      for (const device of devices) {
        if (userId === ownUserId && device.deviceId === ownDeviceId) continue;
        targets.push({ userId, deviceId: device.deviceId });
      }
    }

    // Determine which targets still need a Signal session established.
    const sessionState = await Promise.all(
      targets.map(async (target) => ({
        target,
        hasSession: !!(await loadSession({ userId: target.userId, deviceId: target.deviceId })),
      }))
    );

    // Atomically CLAIM the session-less targets that no concurrent fan-out is
    // already establishing, registering an establishment lock for each in the
    // SAME synchronous tick (no await between the has-check and the set) so two
    // overlapping sends (e.g. a send racing its own 409 retry) can never both run
    // X3DH for the same new device — that would burn two one-time prekeys and
    // overwrite the first session (leaving its message undecryptable). We are the
    // establisher only for the locks WE registered here.
    const establishers = new Map<string, EstablishLock>();
    const claimedTargets: DeviceTarget[] = [];
    for (const { target, hasSession } of sessionState) {
      const key = targetKey(target);
      if (hasSession || sessionEstablishLocks.has(key) || establishers.has(key)) continue;
      const lock = createEstablishLock();
      sessionEstablishLocks.set(key, lock.promise);
      establishers.set(key, lock);
      claimedTargets.push(target);
    }

    const envelopes: MessageEnvelopeDTO[] = [];
    const failures: DeviceTarget[] = [];

    try {
      // Batch X3DH bundles for the targets WE are establishing, in one request.
      const bundlesByTarget =
        claimedTargets.length > 0
          ? await prefetchBundles(claimedTargets)
          : new Map<string, RemotePublicBundle>();

      for (const target of targets) {
        try {
          const ciphertext = await encryptForPeerSerialized(
            target,
            plaintext,
            establishers.get(targetKey(target)),
            async (peer) => {
              const prefetched = bundlesByTarget.get(targetKey(peer));
              if (prefetched) return prefetched;
              // Fall back to the single-device endpoint if the batch missed it.
              return get().getRecipientBundle(peer.userId, peer.deviceId);
            }
          );
          envelopes.push({
            recipientUserId: target.userId,
            recipientDeviceId: target.deviceId,
            ciphertext,
          });
        } catch (error) {
          console.warn(
            `[DeviceKeys] Failed to encrypt for ${target.userId}:${target.deviceId}:`,
            error
          );
          failures.push(target);
        }
      }
    } finally {
      // Safety net: release any establishment lock not already settled by the
      // loop (e.g. if a throw escaped before its target was processed), so
      // concurrent awaiters are never left hanging on this fan-out.
      for (const [key, lock] of establishers) {
        if (sessionEstablishLocks.get(key) === lock.promise) {
          sessionEstablishLocks.delete(key);
          lock.reject(new Error('Session establishment aborted'));
        }
      }
    }

    // A recipient USER with zero successful envelopes can't read the message at
    // all — that's fatal. Own-device-only failures (other devices of the sender)
    // are tolerated: they degrade sent-message sync but never block delivery to
    // the actual recipients.
    const recipientUserIds = uniqueUserIds.filter((id) => id !== ownUserId);
    const usersWithEnvelope = new Set(envelopes.map((e) => e.recipientUserId));
    for (const userId of recipientUserIds) {
      const hadDevices = (devicesByUser.get(userId) || []).length > 0;
      if (hadDevices && !usersWithEnvelope.has(userId)) {
        throw new Error(`Failed to encrypt message for recipient ${userId}`);
      }
    }

    // Best-effort prekey top-up after a fan-out.
    void get().ensurePreKeyStock();

    return { envelopes, failures };
  },

  encryptMessageForRecipient: async (message: string, recipientUserId: string) => {
    // Single-device path used only by the direct P2P send. Resolves the
    // recipient's primary device once so the session is keyed correctly.
    const devices = (await get().getDevicesForUsers([recipientUserId])).get(recipientUserId) || [];
    if (devices.length === 0) {
      throw new Error('No devices found for user');
    }
    const targetDeviceId = devices[0].deviceId;

    const ciphertext = await encryptForPeer(
      { userId: recipientUserId, deviceId: targetDeviceId },
      message,
      {
        fetchPreKeyBundle: async (peer) =>
          get().getRecipientBundle(peer.userId, peer.deviceId),
      }
    );
    void get().ensurePreKeyStock();
    return ciphertext;
  },

  decryptMessageFromSender: async (
    ciphertext: string,
    senderUserId: string,
    senderDeviceId: number
  ) => {
    try {
      const plaintext = await decryptFromPeer(
        { userId: senderUserId, deviceId: senderDeviceId },
        ciphertext
      );
      void get().ensurePreKeyStock();
      return plaintext;
    } catch (error) {
      if (error instanceof LegacyMessageError) {
        throw new Error('[Mensaje no descifrable]');
      }
      throw error;
    }
  },

  handleRevocation: async () => {
    // De-dup concurrent / repeated `device:revoked` events: re-key only once.
    if (revocationInFlight) return revocationInFlight;

    const run = (async (): Promise<number | null> => {
      try {
        console.warn('[DeviceKeys] Device revoked by server; wiping Signal state and re-initializing');
        // 1. Discard all persisted Signal state (identity, prekeys, sessions) and
        //    the cached device-list — everything was tied to the revoked device.
        await wipeAllSignalState();
        setApiDeviceId(null);
        deviceListCache.clear();
        // 2. Drop the in-memory snapshot so initialize() rebuilds from scratch.
        set({ deviceKeys: null, isInitialized: false, isLoading: false, error: null });
        // 3. Re-initialize as a brand new device: mints a fresh device id, sets
        //    the X-Device-Id header and registers the new public bundle. The
        //    socket connect effect re-reads the new device id from this store and
        //    reconnects with it (the server disconnected the old one).
        await get().initialize();
        return get().deviceKeys?.deviceId ?? null;
      } catch (error) {
        console.error('[DeviceKeys] Failed to re-initialize after revocation:', error);
        return null;
      } finally {
        revocationInFlight = null;
      }
    })();

    revocationInFlight = run;
    return run;
  },

  /**
   * Reset only the in-memory store snapshot on logout / account switch.
   *
   * The persisted Signal key material (identity key, prekeys, sessions) in
   * SecureStore is intentionally LEFT INTACT: re-logging into the same account
   * must reuse the existing device identity, and the keys are scoped per-account
   * by the Signal layer. Clearing them would orphan the device server-side and
   * break decryption of history on re-login.
   */
  reset: () => {
    setApiDeviceId(null);
    deviceListCache.clear();
    set({ deviceKeys: null, isInitialized: false, isLoading: false, error: null });
  },
}));

/**
 * Encrypt `plaintext` for one peer, serializing SESSION ESTABLISHMENT per peer.
 *
 * - `lock` set → WE are the establisher for this session-less peer. The
 *   establishing `encryptForPeer` (which runs X3DH + persists the session) settles
 *   the pre-registered lock so concurrent fan-outs wait instead of re-establishing.
 * - `lock` unset, session already exists → steady-state encrypt (no waiting).
 * - `lock` unset, another fan-out is establishing this peer → await its lock, then
 *   encrypt steady-state against the now-persisted session.
 */
async function encryptForPeerSerialized(
  target: DeviceTarget,
  plaintext: string,
  lock: EstablishLock | undefined,
  fetchPreKeyBundle: (peer: { userId: string; deviceId: number }) => Promise<RemotePublicBundle>
): Promise<string> {
  const key = targetKey(target);
  const peer = { userId: target.userId, deviceId: target.deviceId };

  if (lock) {
    try {
      const ciphertext = await encryptForPeer(peer, plaintext, { fetchPreKeyBundle });
      lock.resolve();
      return ciphertext;
    } catch (error) {
      lock.reject(error);
      throw error;
    } finally {
      sessionEstablishLocks.delete(key);
    }
  }

  // Not the establisher: if another fan-out is establishing this peer, wait for
  // it so we encrypt against the shared session rather than racing a second one.
  const inflight = sessionEstablishLocks.get(key);
  if (inflight) {
    try {
      await inflight;
    } catch {
      // The establisher failed; fall through and attempt establishment ourselves.
    }
  }
  return encryptForPeer(peer, plaintext, { fetchPreKeyBundle });
}

/**
 * Fetch X3DH prekey bundles for the given (session-less) targets in batched
 * `/devices/prekeys/batch` requests. Returns a map keyed `${userId}:${deviceId}`.
 */
async function prefetchBundles(
  targets: DeviceTarget[]
): Promise<Map<string, RemotePublicBundle>> {
  const bundles = new Map<string, RemotePublicBundle>();
  if (targets.length === 0) return bundles;

  for (let i = 0; i < targets.length; i += PREKEY_BATCH_MAX_TARGETS) {
    const chunk = targets.slice(i, i + PREKEY_BATCH_MAX_TARGETS);
    try {
      const response = await api.post('/devices/prekeys/batch', { targets: chunk });
      const payload = unwrapBatch(response.data);
      for (const bundle of payload.bundles) {
        bundles.set(`${bundle.userId}:${bundle.deviceId}`, {
          deviceId: bundle.deviceId,
          identityKeyPublic: bundle.identityKeyPublic,
          signedPreKey: bundle.signedPreKey,
          preKey: bundle.preKey,
          registrationId: bundle.registrationId,
        });
      }
    } catch (error) {
      // A failed batch is non-fatal: encryptForPeer falls back to the
      // single-device endpoint per target, and unreachable targets surface as
      // per-device failures.
      console.warn('[DeviceKeys] Batch prekey fetch failed (falling back per-device):', error);
    }
  }

  return bundles;
}

/** Unwrap the `/devices/prekeys/batch` success envelope. */
function unwrapBatch(body: unknown): { bundles: BatchPreKeyBundle[]; missing: DeviceTarget[] } {
  const payload = unwrap<{ bundles?: BatchPreKeyBundle[]; missing?: DeviceTarget[] }>(body);
  return { bundles: payload.bundles || [], missing: payload.missing || [] };
}
