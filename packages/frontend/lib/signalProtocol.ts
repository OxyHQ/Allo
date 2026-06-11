/**
 * Signal Protocol — real X3DH + Double Ratchet implementation.
 *
 * High-level flow:
 *   1. `initializeDeviceKeys()` generates and persists this device's long-term
 *      identity (Ed25519 + X25519), a signed prekey (X25519 signed with Ed25519),
 *      a set of one-time prekeys, a numeric device id and a registration id.
 *   2. `getPublicBundle()` returns the public bundle that is uploaded to the
 *      backend so other devices can run X3DH against us.
 *   3. `encryptForPeer({ userId, deviceId }, plaintext, opts)` performs X3DH on
 *      the first call (fetching the peer prekey bundle via `opts.fetchPreKeyBundle`),
 *      sets up a Double Ratchet session, persists it and returns a base64 wire
 *      payload.
 *   4. `decryptFromPeer({ userId, deviceId }, payload, opts)` parses the wire
 *      payload, completes X3DH on the receiver side if the payload contains an
 *      `x3dh` header, advances the ratchet and returns plaintext. Legacy payloads
 *      throw `LegacyMessageError` so the caller can render a friendly
 *      "[Mensaje no descifrable]" instead of crashing.
 *
 * Backwards compatible surface for existing call sites:
 *   - `initializeDeviceKeys`, `getDeviceKeys`, `storeDeviceKeys`,
 *     `generateIdentityKeyPair`, `generatePreKeys`, `generateSignedPreKey`,
 *     `generateRegistrationId`, `generateDeviceId` are kept.
 *   - `encryptMessage` / `decryptMessage` are kept as thin shims that throw
 *     instructive errors so callers migrate to the session-aware API in
 *     `deviceKeysStore.ts`.
 */

import { Storage } from '@/utils/storage';
import { getSecureItem, setSecureItem, removeSecureItem } from '@/lib/secureStorage';

import {
  KeyPair,
  generateX25519KeyPair,
  generateEd25519KeyPair,
  sign,
  bytesToBase64,
  base64ToBytes,
  utf8ToBytes,
  bytesToUtf8,
  random,
} from '@/lib/signal/keys';
import {
  PreKeyBundle,
  InitialMessageHeader,
  x3dhInitiate,
  x3dhReceive,
} from '@/lib/signal/x3dh';
import {
  RatchetState,
  initRatchetInitiator,
  initRatchetReceiver,
  ratchetEncrypt,
  ratchetDecrypt,
} from '@/lib/signal/doubleRatchet';
import {
  loadSession,
  saveSession,
  wipeAllSessions,
  PeerAddress,
} from '@/lib/signal/sessionStore';
import {
  encodeWire,
  decodeWire,
  LegacyMessageError,
  X3dhWireHeader,
} from '@/lib/signal/wire';

// ---------------------------------------------------------------------------
// Persistence keys.
// ---------------------------------------------------------------------------

const DEVICE_ID_KEY = 'signal_device_id_v2';
const REGISTRATION_ID_KEY = 'signal_registration_id_v2';
const IDENTITY_ED_KEY = 'signal_identity_ed25519_v2';
const IDENTITY_DH_KEY = 'signal_identity_x25519_v2';
const SIGNED_PRE_KEY_KEY = 'signal_signed_prekey_v2';
const PRE_KEYS_KEY = 'signal_prekeys_v2';

/** Public bundle cached in regular storage (mirror of the device's public keys). */
const PUBLIC_BUNDLE_KEY = 'signal_device_keys_public';

/** Every fixed (non-session) secure key holding this device's Signal identity. */
const SIGNAL_IDENTITY_SECURE_KEYS = [
  DEVICE_ID_KEY,
  REGISTRATION_ID_KEY,
  IDENTITY_ED_KEY,
  IDENTITY_DH_KEY,
  SIGNED_PRE_KEY_KEY,
  PRE_KEYS_KEY,
] as const;

const SIGNED_PRE_KEY_ID = 1;
const PREKEY_COUNT = 100;
const PREKEY_LOW_WATERMARK = 20;

// ---------------------------------------------------------------------------
// Public types kept compatible with the legacy interface used by the stores.
// ---------------------------------------------------------------------------

export interface SignedPreKeyPublic {
  keyId: number;
  publicKey: string;
  signature: string;
}

export interface PreKeyPublic {
  keyId: number;
  publicKey: string;
}

export interface DeviceKeys {
  deviceId: number;
  /**
   * Combined identity public key: base64(Ed25519 pub || X25519 pub).
   * Kept under the same JSON property name so the backend schema does not
   * need to change.
   */
  identityKeyPublic: string;
  /** Combined identity private key: base64(Ed25519 priv || X25519 priv). */
  identityKeyPrivate: string;
  signedPreKey: {
    keyId: number;
    publicKey: string;
    privateKey: string;
    signature: string;
  };
  preKeys: Array<{
    keyId: number;
    publicKey: string;
    privateKey: string;
  }>;
  registrationId: number;
}

export interface PublicBundle {
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: SignedPreKeyPublic;
  preKeys: PreKeyPublic[];
  registrationId: number;
}

export { LegacyMessageError };

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

const ED_PUB_LEN = 32;
const X_PUB_LEN = 32;
const ED_PRIV_LEN = 32;
const X_PRIV_LEN = 32;

function packIdentityPublic(ed: Uint8Array, dh: Uint8Array): string {
  const out = new Uint8Array(ED_PUB_LEN + X_PUB_LEN);
  out.set(ed, 0);
  out.set(dh, ED_PUB_LEN);
  return bytesToBase64(out);
}

function unpackIdentityPublic(base64: string): { ed: Uint8Array; dh: Uint8Array } {
  const all = base64ToBytes(base64);
  if (all.length !== ED_PUB_LEN + X_PUB_LEN) {
    throw new Error('Invalid identity public key length');
  }
  return {
    ed: all.subarray(0, ED_PUB_LEN),
    dh: all.subarray(ED_PUB_LEN),
  };
}

function packIdentityPrivate(ed: Uint8Array, dh: Uint8Array): string {
  const out = new Uint8Array(ED_PRIV_LEN + X_PRIV_LEN);
  out.set(ed, 0);
  out.set(dh, ED_PRIV_LEN);
  return bytesToBase64(out);
}

function unpackIdentityPrivate(base64: string): { ed: Uint8Array; dh: Uint8Array } {
  const all = base64ToBytes(base64);
  if (all.length !== ED_PRIV_LEN + X_PRIV_LEN) {
    throw new Error('Invalid identity private key length');
  }
  return {
    ed: all.subarray(0, ED_PRIV_LEN),
    dh: all.subarray(ED_PRIV_LEN),
  };
}

function randomNonZeroInt32(): number {
  // Use cryptographic randomness for ids.
  const bytes = random(4);
  const v =
    ((bytes[0] & 0x7f) << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
  return v === 0 ? 1 : v;
}

// ---------------------------------------------------------------------------
// Key generation primitives (compat-named exports).
// ---------------------------------------------------------------------------

export async function generateDeviceId(): Promise<number> {
  const existing = await getSecureItem(DEVICE_ID_KEY);
  if (existing) return parseInt(existing, 10);
  const deviceId = randomNonZeroInt32();
  await setSecureItem(DEVICE_ID_KEY, deviceId.toString());
  return deviceId;
}

export async function generateRegistrationId(): Promise<number> {
  const existing = await getSecureItem(REGISTRATION_ID_KEY);
  if (existing) return parseInt(existing, 10);
  const id = randomNonZeroInt32();
  await setSecureItem(REGISTRATION_ID_KEY, id.toString());
  return id;
}

/**
 * Generate a fresh identity key pair (Ed25519 for signatures + X25519 for DH).
 * Returns the combined base64 representation used by the rest of the app.
 */
export async function generateIdentityKeyPair(): Promise<{
  publicKey: string;
  privateKey: string;
}> {
  const ed = generateEd25519KeyPair();
  const dh = generateX25519KeyPair();
  return {
    publicKey: packIdentityPublic(ed.publicKey, dh.publicKey),
    privateKey: packIdentityPrivate(ed.privateKey, dh.privateKey),
  };
}

export async function generateSignedPreKey(
  identityKeyPair: { publicKey: string; privateKey: string },
  keyId: number = SIGNED_PRE_KEY_ID
): Promise<{
  keyId: number;
  publicKey: string;
  privateKey: string;
  signature: string;
}> {
  const spk = generateX25519KeyPair();
  const { ed: edPriv } = unpackIdentityPrivate(identityKeyPair.privateKey);
  const signature = sign(spk.publicKey, edPriv);
  return {
    keyId,
    publicKey: bytesToBase64(spk.publicKey),
    privateKey: bytesToBase64(spk.privateKey),
    signature: bytesToBase64(signature),
  };
}

export async function generatePreKeys(
  count: number = PREKEY_COUNT,
  startKeyId: number = 1
): Promise<
  Array<{
    keyId: number;
    publicKey: string;
    privateKey: string;
  }>
> {
  const out: Array<{ keyId: number; publicKey: string; privateKey: string }> = [];
  for (let i = 0; i < count; i++) {
    const pair = generateX25519KeyPair();
    out.push({
      keyId: startKeyId + i,
      publicKey: bytesToBase64(pair.publicKey),
      privateKey: bytesToBase64(pair.privateKey),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Device key lifecycle.
// ---------------------------------------------------------------------------

export async function initializeDeviceKeys(): Promise<DeviceKeys> {
  const existing = await getDeviceKeys();
  if (existing) return existing;

  const deviceId = await generateDeviceId();
  const identity = await generateIdentityKeyPair();
  const registrationId = await generateRegistrationId();
  const signedPreKey = await generateSignedPreKey(identity);
  const preKeys = await generatePreKeys();

  const keys: DeviceKeys = {
    deviceId,
    identityKeyPublic: identity.publicKey,
    identityKeyPrivate: identity.privateKey,
    signedPreKey,
    preKeys,
    registrationId,
  };
  await storeDeviceKeys(keys);
  return keys;
}

/**
 * Wipe ALL persisted Signal Protocol state for this device: the long-term
 * identity (Ed25519 + X25519), signed prekey, one-time prekeys, device id,
 * registration id, the cached public bundle and every Double Ratchet session.
 *
 * After this call `getDeviceKeys()` returns null and `generateDeviceId()` mints
 * a fresh device id, so a subsequent `initializeDeviceKeys()` produces a brand
 * new device identity. Used when the server revokes this device (`device:revoked`):
 * the old identity is no longer trusted and must not be reused.
 */
export async function wipeAllSignalState(): Promise<void> {
  await Promise.all([
    ...SIGNAL_IDENTITY_SECURE_KEYS.map((key) => removeSecureItem(key)),
    Storage.remove(PUBLIC_BUNDLE_KEY),
    wipeAllSessions(),
  ]);
}

export async function storeDeviceKeys(keys: DeviceKeys): Promise<void> {
  const id = unpackIdentityPublic(keys.identityKeyPublic);
  const idPriv = unpackIdentityPrivate(keys.identityKeyPrivate);

  await setSecureItem(
    IDENTITY_ED_KEY,
    JSON.stringify({
      public: bytesToBase64(id.ed),
      private: bytesToBase64(idPriv.ed),
    })
  );
  await setSecureItem(
    IDENTITY_DH_KEY,
    JSON.stringify({
      public: bytesToBase64(id.dh),
      private: bytesToBase64(idPriv.dh),
    })
  );
  await setSecureItem(SIGNED_PRE_KEY_KEY, JSON.stringify(keys.signedPreKey));
  await setSecureItem(PRE_KEYS_KEY, JSON.stringify(keys.preKeys));
  await setSecureItem(DEVICE_ID_KEY, keys.deviceId.toString());
  await setSecureItem(REGISTRATION_ID_KEY, keys.registrationId.toString());

  await Storage.set(PUBLIC_BUNDLE_KEY, {
    deviceId: keys.deviceId,
    identityKeyPublic: keys.identityKeyPublic,
    signedPreKey: {
      keyId: keys.signedPreKey.keyId,
      publicKey: keys.signedPreKey.publicKey,
      signature: keys.signedPreKey.signature,
    },
    preKeys: keys.preKeys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })),
    registrationId: keys.registrationId,
  });
}

export async function getDeviceKeys(): Promise<DeviceKeys | null> {
  try {
    const [
      edRaw,
      dhRaw,
      signedPreKeyStr,
      preKeysStr,
      deviceIdStr,
      registrationIdStr,
    ] = await Promise.all([
      getSecureItem(IDENTITY_ED_KEY),
      getSecureItem(IDENTITY_DH_KEY),
      getSecureItem(SIGNED_PRE_KEY_KEY),
      getSecureItem(PRE_KEYS_KEY),
      getSecureItem(DEVICE_ID_KEY),
      getSecureItem(REGISTRATION_ID_KEY),
    ]);

    if (!edRaw || !dhRaw || !signedPreKeyStr || !preKeysStr || !deviceIdStr || !registrationIdStr) {
      return null;
    }

    const ed = JSON.parse(edRaw) as { public: string; private: string };
    const dh = JSON.parse(dhRaw) as { public: string; private: string };
    const signedPreKey = JSON.parse(signedPreKeyStr);
    const preKeys = JSON.parse(preKeysStr);

    return {
      deviceId: parseInt(deviceIdStr, 10),
      registrationId: parseInt(registrationIdStr, 10),
      identityKeyPublic: packIdentityPublic(
        base64ToBytes(ed.public),
        base64ToBytes(dh.public)
      ),
      identityKeyPrivate: packIdentityPrivate(
        base64ToBytes(ed.private),
        base64ToBytes(dh.private)
      ),
      signedPreKey,
      preKeys,
    };
  } catch (error) {
    console.error('[SignalProtocol] Error getting device keys:', error);
    return null;
  }
}

export async function getPublicBundle(): Promise<PublicBundle | null> {
  const keys = await getDeviceKeys();
  if (!keys) return null;
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

/**
 * Remove a one-time prekey we have already consumed. Persists the updated list
 * back to secure storage.
 */
export async function consumeLocalOneTimePreKey(keyId: number): Promise<void> {
  const keys = await getDeviceKeys();
  if (!keys) return;
  const next = keys.preKeys.filter((k) => k.keyId !== keyId);
  if (next.length === keys.preKeys.length) return;
  keys.preKeys = next;
  await storeDeviceKeys(keys);
}

/** Returns the number of remaining one-time prekeys (used to trigger replenish). */
export async function remainingOneTimePreKeys(): Promise<number> {
  const keys = await getDeviceKeys();
  return keys ? keys.preKeys.length : 0;
}

export const PREKEY_LOW_THRESHOLD = PREKEY_LOW_WATERMARK;

/**
 * Generate `count` new one-time prekeys, append them locally and return ONLY
 * the public portion suitable for upload to the server.
 */
export async function generateAndStoreNewPreKeys(
  count: number = PREKEY_COUNT
): Promise<PreKeyPublic[]> {
  const keys = await getDeviceKeys();
  if (!keys) throw new Error('Device keys not initialized');
  const nextId =
    keys.preKeys.reduce((max, k) => (k.keyId > max ? k.keyId : max), 0) + 1;
  const fresh = await generatePreKeys(count, nextId);
  keys.preKeys = keys.preKeys.concat(fresh);
  await storeDeviceKeys(keys);
  return fresh.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey }));
}

// ---------------------------------------------------------------------------
// Session-aware encryption / decryption.
// ---------------------------------------------------------------------------

/** Public bundle as received from the server (REST shape). */
export interface RemotePublicBundle {
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: SignedPreKeyPublic;
  /** Single one-time prekey that the server atomically consumed for us. */
  preKey?: PreKeyPublic | null;
  registrationId?: number;
}

export interface EncryptOptions {
  /**
   * Called on the very first message to a peer. Must perform the network round
   * trip to fetch the prekey bundle (and atomically consume one OPK).
   */
  fetchPreKeyBundle: (peer: PeerAddress) => Promise<RemotePublicBundle>;
}

export interface DecryptOptions {
  /**
   * Called on the very first inbound message to look up the receiver's local
   * private one-time prekey by id (returns null if the prekey is unknown).
   */
  getLocalPreKeyPrivate?: (keyId: number) => Promise<string | null>;
}

/**
 * Encrypt `plaintext` for the given peer. Establishes a session via X3DH on the
 * first call (using `opts.fetchPreKeyBundle`).
 */
export async function encryptForPeer(
  peer: PeerAddress,
  plaintext: string,
  opts: EncryptOptions
): Promise<string> {
  let state = await loadSession(peer);
  let x3dhWire: X3dhWireHeader | undefined;

  if (!state) {
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) throw new Error('Device keys not initialized');

    const remoteBundle = await opts.fetchPreKeyBundle(peer);
    if (!remoteBundle) {
      throw new Error('No prekey bundle available for peer');
    }

    const remoteIds = unpackIdentityPublic(remoteBundle.identityKeyPublic);

    const bundle: PreKeyBundle = {
      identityKeyEd: remoteIds.ed,
      identityKeyDh: remoteIds.dh,
      signedPreKey: {
        keyId: remoteBundle.signedPreKey.keyId,
        publicKey: base64ToBytes(remoteBundle.signedPreKey.publicKey),
        signature: base64ToBytes(remoteBundle.signedPreKey.signature),
      },
      oneTimePreKey: remoteBundle.preKey
        ? {
            keyId: remoteBundle.preKey.keyId,
            publicKey: base64ToBytes(remoteBundle.preKey.publicKey),
          }
        : undefined,
    };

    const ourIdPriv = unpackIdentityPrivate(ourKeys.identityKeyPrivate);
    const ourIdPub = unpackIdentityPublic(ourKeys.identityKeyPublic);

    const initResult = x3dhInitiate(
      {
        publicKey: ourIdPub.dh,
        privateKey: ourIdPriv.dh,
      },
      bundle
    );

    state = initRatchetInitiator(initResult.sharedSecret, initResult.peerSignedPreKey);

    x3dhWire = {
      ek: bytesToBase64(initResult.ephemeralPublicKey),
      ikE: bytesToBase64(ourIdPub.ed),
      ikD: bytesToBase64(ourIdPub.dh),
      spk: initResult.usedSignedPreKeyId,
      ...(initResult.usedOneTimePreKeyId !== undefined
        ? { opk: initResult.usedOneTimePreKeyId }
        : {}),
    };
  }

  const ratchetMsg = ratchetEncrypt(state, utf8ToBytes(plaintext));
  await saveSession(peer, state);

  return encodeWire(ratchetMsg, x3dhWire);
}

/**
 * Decrypt `payload` from the given peer. Establishes a session via X3DH on the
 * first inbound message (looking up our local prekey by `opts.getLocalPreKeyPrivate`).
 *
 * Throws `LegacyMessageError` for unknown / legacy formats so the caller can
 * render a friendly error.
 */
export async function decryptFromPeer(
  peer: PeerAddress,
  payload: string,
  opts: DecryptOptions = {}
): Promise<string> {
  const decoded = decodeWire(payload); // throws LegacyMessageError for old format

  let state = await loadSession(peer);

  if (!state) {
    if (!decoded.x3dh) {
      // No session and no X3DH handshake — we cannot decrypt.
      throw new Error('No session for peer and missing X3DH header');
    }
    const ourKeys = await getDeviceKeys();
    if (!ourKeys) throw new Error('Device keys not initialized');

    const ourIdPriv = unpackIdentityPrivate(ourKeys.identityKeyPrivate);
    const ourIdPub = unpackIdentityPublic(ourKeys.identityKeyPublic);

    if (decoded.x3dh.spk !== ourKeys.signedPreKey.keyId) {
      throw new Error('X3DH: signed prekey id mismatch');
    }
    const spkPair: KeyPair = {
      publicKey: base64ToBytes(ourKeys.signedPreKey.publicKey),
      privateKey: base64ToBytes(ourKeys.signedPreKey.privateKey),
    };

    let opkPair: KeyPair | undefined;
    if (decoded.x3dh.opk !== undefined) {
      const local = ourKeys.preKeys.find((k) => k.keyId === decoded.x3dh!.opk);
      if (local) {
        opkPair = {
          publicKey: base64ToBytes(local.publicKey),
          privateKey: base64ToBytes(local.privateKey),
        };
      } else if (opts.getLocalPreKeyPrivate) {
        const privB64 = await opts.getLocalPreKeyPrivate(decoded.x3dh.opk);
        if (privB64) {
          // We only have the private key; the public key isn't needed for x3dhReceive.
          opkPair = {
            publicKey: new Uint8Array(0),
            privateKey: base64ToBytes(privB64),
          };
        }
      }
      if (!opkPair) {
        throw new Error('X3DH: one-time prekey not found locally');
      }
    }

    const header: InitialMessageHeader = {
      identityKeyEd: base64ToBytes(decoded.x3dh.ikE),
      identityKeyDh: base64ToBytes(decoded.x3dh.ikD),
      ephemeralKey: base64ToBytes(decoded.x3dh.ek),
      usedSignedPreKeyId: decoded.x3dh.spk,
      usedOneTimePreKeyId: decoded.x3dh.opk,
    };

    const sharedSecret = x3dhReceive(
      {
        identityKeyDh: {
          publicKey: ourIdPub.dh,
          privateKey: ourIdPriv.dh,
        },
        signedPreKey: spkPair,
        oneTimePreKey: opkPair,
      },
      header
    );

    state = initRatchetReceiver(sharedSecret, spkPair);

    // Consume the OPK locally now that we've used it.
    if (decoded.x3dh.opk !== undefined) {
      await consumeLocalOneTimePreKey(decoded.x3dh.opk);
    }
  }

  const plaintext = ratchetDecrypt(state, decoded.message);
  await saveSession(peer, state);
  return bytesToUtf8(plaintext);
}

// ---------------------------------------------------------------------------
// Legacy compatibility shims.
//
// Callers that previously used encryptMessage / decryptMessage with a raw public
// key are no longer supported because the Double Ratchet requires a stateful
// session keyed by peer userId+deviceId. The store layer (`deviceKeysStore`) is
// updated to use the new session-aware API.
// ---------------------------------------------------------------------------

export async function encryptMessage(
  _message: string,
  _recipientPublicKey: string
): Promise<string> {
  throw new Error(
    'encryptMessage(plaintext, recipientPublicKey) is no longer supported. Use encryptForPeer(peer, plaintext, opts) via deviceKeysStore.'
  );
}

export async function decryptMessage(
  _ciphertext: string,
  _senderPublicKey: string
): Promise<string> {
  throw new Error(
    'decryptMessage(ciphertext, senderPublicKey) is no longer supported. Use decryptFromPeer(peer, payload, opts) via deviceKeysStore.'
  );
}
