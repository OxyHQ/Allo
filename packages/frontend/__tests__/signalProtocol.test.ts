/**
 * Tests for the Signal Protocol crypto primitives (lib/signalProtocol.ts).
 *
 * These prove the pure-JS (@noble) implementation is correct AND that its wire
 * format is byte-compatible with the previous WebCrypto implementation, so
 * existing web-encrypted data and cross-client interop keep working. Secure
 * storage is mocked with an in-memory map so the crypto functions can be
 * exercised deterministically without touching a device keystore.
 */

// In-memory secure storage so getDeviceKeys()/storeDeviceKeys() are hermetic.
jest.mock('@/lib/secureStorage', () => {
  const store = new Map<string, string>();
  return {
    getSecureItem: jest.fn((key: string): Promise<string | null> => Promise.resolve(store.get(key) ?? null)),
    setSecureItem: jest.fn((key: string, value: string): Promise<boolean> => {
      store.set(key, value);
      return Promise.resolve(true);
    }),
    removeSecureItem: jest.fn((key: string): Promise<boolean> => {
      store.delete(key);
      return Promise.resolve(true);
    }),
  };
});

jest.mock('@/utils/storage', () => ({
  Storage: {
    set: jest.fn((): Promise<void> => Promise.resolve()),
    get: jest.fn((): Promise<null> => Promise.resolve(null)),
    remove: jest.fn((): Promise<void> => Promise.resolve()),
  },
}));

import { removeSecureItem } from '@/lib/secureStorage';
import {
  DeviceKeys,
  generateKeyPair,
  generateIdentityKeyPair,
  generateSignedPreKey,
  generatePreKeys,
  generateDeviceId,
  storeDeviceKeys,
  getDeviceKeys,
  encryptMessage,
  decryptMessage,
  signData,
  verifySignature,
  deriveSharedSecret,
} from '@/lib/signalProtocol';

// Storage keys owned by lib/signalProtocol.ts (kept in sync intentionally).
const STORAGE_KEYS = [
  'signal_device_id',
  'signal_identity_keypair',
  'signal_registration_id',
  'signal_signed_prekey',
  'signal_prekeys',
];

const toB64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const fromB64 = (value: string): Uint8Array => new Uint8Array(Buffer.from(value, 'base64'));

async function makeDevice(): Promise<DeviceKeys> {
  const identity = await generateIdentityKeyPair();
  const signedPreKey = await generateSignedPreKey(identity);
  const preKeys = await generatePreKeys(1);
  return {
    deviceId: 1,
    identityKeyPublic: identity.publicKey,
    identityKeyPrivate: identity.privateKey,
    signedPreKey,
    preKeys,
    registrationId: 1,
  };
}

beforeEach(async () => {
  await Promise.all(STORAGE_KEYS.map((key) => removeSecureItem(key)));
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('key generation', () => {
  it('generates a P-256 key pair in the expected wire format', () => {
    const { publicKey, privateKey } = generateKeyPair();
    const pub = fromB64(publicKey);
    const priv = fromB64(privateKey);
    // 65-byte uncompressed SEC1 point (0x04 || X || Y) — matches WebCrypto exportKey('raw').
    expect(pub.length).toBe(65);
    expect(pub[0]).toBe(0x04);
    // 32-byte raw scalar.
    expect(priv.length).toBe(32);
  });
});

describe('ECDH key agreement', () => {
  it('derives a symmetric 32-byte shared secret', () => {
    const a = generateKeyPair();
    const b = generateKeyPair();
    const secretAB = deriveSharedSecret(a.privateKey, b.publicKey);
    const secretBA = deriveSharedSecret(b.privateKey, a.publicKey);
    expect(secretAB.length).toBe(32);
    expect(Buffer.from(secretAB).equals(Buffer.from(secretBA))).toBe(true);
  });
});

describe('message encryption', () => {
  it('round-trips a message between two devices', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();

    // Encrypt uses OUR private key + recipient public key.
    await storeDeviceKeys(alice);
    const ciphertext = await encryptMessage('hey bob \u{1F44B}', bob.identityKeyPublic);

    // Decrypt uses OUR private key + sender public key (ECDH is symmetric).
    await storeDeviceKeys(bob);
    const plaintext = await decryptMessage(ciphertext, alice.identityKeyPublic);

    expect(plaintext).toBe('hey bob \u{1F44B}');
  });

  it('produces a blob of IV(12) || ciphertext || tag(16)', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    await storeDeviceKeys(alice);

    const message = 'hello world';
    const ciphertext = await encryptMessage(message, bob.identityKeyPublic);
    const blob = Buffer.from(ciphertext, 'base64');

    expect(blob.length).toBe(12 + Buffer.byteLength(message, 'utf8') + 16);
  });

  it('rejects a ciphertext that is too short to hold an IV and tag', async () => {
    const alice = await makeDevice();
    const bob = await makeDevice();
    await storeDeviceKeys(alice);
    await expect(decryptMessage(toB64(new Uint8Array(8)), bob.identityKeyPublic)).rejects.toThrow();
  });
});

describe('signatures', () => {
  it('signs and verifies with real ECDSA-P256 (no insecure fallback)', async () => {
    const kp = await generateIdentityKeyPair();
    const data = 'authenticate me';
    const signature = await signData(data, kp.privateKey);

    // 64-byte compact r||s — proves this is a real ECDSA signature, not the
    // removed btoa(data + privateKey.slice(0, 32)) fallback.
    expect(fromB64(signature).length).toBe(64);
    expect(await verifySignature(data, signature, kp.publicKey)).toBe(true);
    expect(await verifySignature('authenticate you', signature, kp.publicKey)).toBe(false);
  });

  it('throws instead of returning a fake signature when the private key is invalid', async () => {
    const invalidKey = toB64(new Uint8Array([1, 2, 3, 4, 5]));
    await expect(signData('x', invalidKey)).rejects.toThrow();
  });
});

describe('secure identifiers', () => {
  it('generates device ids from a CSPRNG, never Math.random', async () => {
    const randomSpy = jest.spyOn(Math, 'random');

    const deviceId = await generateDeviceId();

    expect(randomSpy).not.toHaveBeenCalled();
    expect(Number.isInteger(deviceId)).toBe(true);
    expect(deviceId).toBeGreaterThanOrEqual(1);
    expect(deviceId).toBeLessThanOrEqual(2147483647);
  });

  it('persists the device id so it is stable across calls', async () => {
    const first = await generateDeviceId();
    const second = await generateDeviceId();
    expect(second).toBe(first);
  });
});

describe('interop with the legacy WebCrypto wire format', () => {
  const subtle = globalThis.crypto.subtle;

  it('decrypts a WebCrypto-produced message and migrates a legacy PKCS8 identity key', async () => {
    // "Us": identity private key stored as legacy WebCrypto PKCS8 DER.
    const usKeyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const usPkcs8 = toB64(new Uint8Array(await subtle.exportKey('pkcs8', usKeyPair.privateKey)));
    const usPublic = toB64(new Uint8Array(await subtle.exportKey('raw', usKeyPair.publicKey)));

    // Sender device.
    const senderKeyPair = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const senderPublic = toB64(new Uint8Array(await subtle.exportKey('raw', senderKeyPair.publicKey)));

    // Sender encrypts a message to us with WebCrypto (raw X-coord AES-256 key, no KDF).
    const shared = new Uint8Array(
      await subtle.deriveBits({ name: 'ECDH', public: usKeyPair.publicKey }, senderKeyPair.privateKey, 256)
    );
    const aesKey = await subtle.importKey('raw', shared, { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
    const message = 'legacy interop ✓';
    const sealed = new Uint8Array(
      await subtle.encrypt({ name: 'AES-GCM', iv }, aesKey, new TextEncoder().encode(message))
    );
    const blob = new Uint8Array(iv.length + sealed.length);
    blob.set(iv, 0);
    blob.set(sealed, iv.length);

    // Store our device with the LEGACY PKCS8 identity private key.
    await storeDeviceKeys({
      deviceId: 1,
      identityKeyPublic: usPublic,
      identityKeyPrivate: usPkcs8,
      signedPreKey: { keyId: 1, publicKey: usPublic, privateKey: usPkcs8, signature: '' },
      preKeys: [{ keyId: 1, publicKey: usPublic, privateKey: usPkcs8 }],
      registrationId: 1,
    });

    // getDeviceKeys() must migrate the PKCS8 scalar and decrypt the WebCrypto blob.
    const decrypted = await decryptMessage(toB64(blob), senderPublic);
    expect(decrypted).toBe(message);
  });

  it('verifies a signature produced by WebCrypto ECDSA-P256', async () => {
    const kp = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
    const publicKey = toB64(new Uint8Array(await subtle.exportKey('raw', kp.publicKey)));
    const data = 'signed by webcrypto';
    const signature = new Uint8Array(
      await subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(data))
    );

    expect(signature.length).toBe(64);
    expect(await verifySignature(data, toB64(signature), publicKey)).toBe(true);
    expect(await verifySignature('tampered', toB64(signature), publicKey)).toBe(false);
  });

  it('decrypts a frozen known-answer vector (byte-format stability)', async () => {
    // Produced offline by WebCrypto P-256 ECDH + AES-256-GCM (IV = 01..0c).
    const identityScalar = '5XuS7HNs1KBIFnqghCsVJLmveBebotHI+SnanWXMec4=';
    const identityPublic = 'BC78Dh7pl0xXLoBrEFJGvH0Grbs5VObkRBUS5bCu3eL7w1Ub2eARxsK3YqwrFs32JiWae9kL+intmZgTS8eikZQ=';
    const senderPublic = 'BGjDRT2FiCay3/ZrNiZohkHBI0uU4hCZYUPTM6XV0DJMzaSrs8Ki7xsdsshM/SOPtzZmcHYWR9XzFqnOZIFypHA=';
    const ciphertext = 'AQIDBAUGBwgJCgsMPIguVDCIfkjT5vwlv2YCvOVbmfM9rzDUvsRqwtMde9HZgNglHijUKeUrQKU=';

    await storeDeviceKeys({
      deviceId: 1,
      identityKeyPublic: identityPublic,
      identityKeyPrivate: identityScalar,
      signedPreKey: { keyId: 1, publicKey: identityPublic, privateKey: identityScalar, signature: '' },
      preKeys: [{ keyId: 1, publicKey: identityPublic, privateKey: identityScalar }],
      registrationId: 1,
    });

    expect(await decryptMessage(ciphertext, senderPublic)).toBe('Allo E2E known-answer vector');
  });
});

describe('PKCS8 parser hardening (malformed key material)', () => {
  const subtle = globalThis.crypto.subtle;

  // Store a device whose identity PRIVATE key is the given (bad) value, then run
  // it back through the public getDeviceKeys() path. loadPrivateScalar() only
  // runs on the identity private key, so that is what triggers the parser.
  async function loadWithIdentityPrivate(badPrivateKey: string): Promise<DeviceKeys | null> {
    await storeDeviceKeys({
      deviceId: 1,
      identityKeyPublic: 'unused-public-key',
      identityKeyPrivate: badPrivateKey,
      signedPreKey: { keyId: 1, publicKey: '', privateKey: badPrivateKey, signature: '' },
      preKeys: [{ keyId: 1, publicKey: '', privateKey: badPrivateKey }],
      registrationId: 1,
    });
    return getDeviceKeys();
  }

  // A garbage blob must NEVER be silently normalized into an all-zero scalar
  // (a catastrophic, attacker-predictable "key"). Defensive: if a key ever came
  // back at all, it must not be 32 zero bytes.
  const assertNoAllZeroScalar = (result: DeviceKeys | null): void => {
    if (result) {
      const scalar = fromB64(result.identityKeyPrivate);
      const isAllZero = scalar.length === 32 && scalar.every((b) => b === 0);
      expect(isAllZero).toBe(false);
    }
  };

  it('returns null (never an all-zero scalar, and never logs key bytes) for a truncated PKCS8 identity key', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    const kp = await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
    const realPkcs8 = new Uint8Array(await subtle.exportKey('pkcs8', kp.privateKey));
    const truncated = toB64(realPkcs8.slice(0, 10));

    const result = await loadWithIdentityPrivate(truncated);

    assertNoAllZeroScalar(result);
    expect(result).toBeNull();

    // Fix 2: the corrupt-key warning logs the "migrating legacy key" marker and
    // only the error's class name — never the offending key material.
    expect(warnSpy).toHaveBeenCalled();
    const loggedArgs = warnSpy.mock.calls.flat().map((a) => String(a));
    expect(loggedArgs.some((a) => a.includes('migrating legacy key'))).toBe(true);
    expect(loggedArgs.some((a) => a.includes(truncated))).toBe(false);
  });

  it('returns null (never an all-zero scalar) for a garbage 40-byte identity key', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);

    // Deterministic 40-byte non-DER blob (not 32 bytes → routed to the PKCS8 parser).
    const garbage = new Uint8Array(40);
    for (let i = 0; i < garbage.length; i++) {
      garbage[i] = (i * 73 + 19) & 0xff;
    }

    const result = await loadWithIdentityPrivate(toB64(garbage));

    assertNoAllZeroScalar(result);
    expect(result).toBeNull();
  });
});
