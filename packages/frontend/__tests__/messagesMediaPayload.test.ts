/**
 * Store-level tests for the encrypted-media RECEIVE path (Fase 1D).
 *
 * Exercises `applyDecryptedBody` — the single decode point shared by the fetch,
 * local-cache and realtime decrypt sites — to verify:
 *  - a decrypted v3 media payload reconstructs renderable, key-bearing media
 *  - a decrypted plain-text body stays plain text (legacy + caption-only)
 *  - the JSON-wrapper detection never misreads user text as media
 *
 * The heavy native modules pulled in transitively by the store are mocked.
 */

// --- Mocks for native / heavy modules ---

jest.mock('expo-constants', () => ({
  __esModule: true,
  default: { deviceName: 'Test Device', expoConfig: { name: 'Allo' } },
}));

jest.mock('@/utils/api', () => ({
  api: { get: jest.fn(), post: jest.fn(), put: jest.fn(), delete: jest.fn(), patch: jest.fn() },
  setApiDeviceId: jest.fn(),
}));

jest.mock('@/lib/signalProtocol', () => ({
  __esModule: true,
  initializeDeviceKeys: jest.fn(),
  getDeviceKeys: jest.fn(),
  encryptForPeer: jest.fn(),
  decryptFromPeer: jest.fn(),
  remainingOneTimePreKeys: jest.fn(async () => 100),
  generateAndStoreNewPreKeys: jest.fn(async () => []),
  PREKEY_LOW_THRESHOLD: 20,
  LegacyMessageError: class LegacyMessageError extends Error {},
}));

jest.mock('@/lib/signal/sessionStore', () => ({
  loadSession: jest.fn(),
  saveSession: jest.fn(),
  deleteSession: jest.fn(),
  clearSessionMemoryCache: jest.fn(),
}));

jest.mock('@/lib/offlineStorage', () => ({
  storeMessagesLocally: jest.fn(async () => undefined),
  getMessagesLocally: jest.fn(async () => []),
  addMessageLocally: jest.fn(async () => undefined),
  updateMessageLocally: jest.fn(async () => undefined),
  removeMessageLocally: jest.fn(async () => undefined),
  addToSyncQueue: jest.fn(async () => undefined),
}));

jest.mock('@/lib/p2pMessaging', () => ({
  p2pManager: { sendMessage: jest.fn(() => false) },
}));

// mediaCache imports expo-file-system (native) — stub the whole module.
jest.mock('@/lib/mediaCache', () => ({
  seedDecryptedMediaUrl: jest.fn(),
  peekDecryptedMediaUrl: jest.fn(),
  getDecryptedMediaUrl: jest.fn(),
  clearDecryptedMediaCache: jest.fn(),
}));

// outgoingMedia imports mediaCache + uploadAttachment (native) — stub it.
jest.mock('@/lib/outgoingMedia', () => ({
  prepareEncryptedMedia: jest.fn(),
  preparePlaintextMedia: jest.fn(),
  toForwardSources: jest.fn(),
}));

// eslint-disable-next-line import/first
import { applyDecryptedBody } from '@/stores/messagesStore';
// eslint-disable-next-line import/first
import { serializeMediaBody, type MediaRef } from '@/lib/mediaPayload';

describe('applyDecryptedBody (encrypted-media receive path)', () => {
  const ref: MediaRef = {
    mediaId: 'mX',
    url: 'https://cdn.example/mX.bin',
    key: 'a2V5',
    mime: 'image/png',
    size: 4096,
    type: 'image',
    fileName: 'pic.png',
    width: 100,
    height: 200,
  };

  it('reconstructs key-bearing media items from a decrypted media payload', () => {
    const body = serializeMediaBody({ text: 'look', mediaRefs: [ref] });
    const result = applyDecryptedBody(body);
    expect(result.text).toBe('look');
    expect(result.attachmentType).toBe('image');
    expect(result.media).toHaveLength(1);
    expect(result.media?.[0]).toMatchObject({
      id: 'mX',
      type: 'image',
      url: 'https://cdn.example/mX.bin',
      encrypted: true,
      encryptionKey: 'a2V5',
      mimeType: 'image/png',
    });
  });

  it('maps a gif ref to the gif attachment type', () => {
    const gifRef: MediaRef = { ...ref, type: 'gif', mediaId: 'g1' };
    const result = applyDecryptedBody(serializeMediaBody({ mediaRefs: [gifRef] }));
    expect(result.attachmentType).toBe('gif');
    expect(result.media?.[0].type).toBe('gif');
  });

  it('keeps a caption-only (plain text) body as plain text', () => {
    const result = applyDecryptedBody('hello there');
    expect(result).toEqual({ text: 'hello there' });
    expect(result.media).toBeUndefined();
  });

  it('does not misread user text that looks like JSON as media', () => {
    const result = applyDecryptedBody('{"note":"not a media payload"}');
    expect(result.media).toBeUndefined();
    expect(result.text).toBe('{"note":"not a media payload"}');
  });

  it('surfaces an encrypted location and routes to the location type', () => {
    const body = serializeMediaBody({
      mediaRefs: [],
      location: { latitude: 41.4, longitude: 2.2, label: 'Home' },
    });
    const result = applyDecryptedBody(body);
    expect(result.attachmentType).toBe('location');
    expect(result.location).toEqual({ latitude: 41.4, longitude: 2.2, label: 'Home' });
    expect(result.media).toBeUndefined();
    expect(result.contact).toBeUndefined();
  });

  it('surfaces an encrypted contact and routes to the contact type', () => {
    const body = serializeMediaBody({
      mediaRefs: [],
      contact: { name: 'Grace Hopper', emails: ['grace@example.com'] },
    });
    const result = applyDecryptedBody(body);
    expect(result.attachmentType).toBe('contact');
    expect(result.contact).toEqual({ name: 'Grace Hopper', emails: ['grace@example.com'] });
    expect(result.location).toBeUndefined();
  });

  it('prefers the media type when media and a location coexist', () => {
    const body = serializeMediaBody({
      mediaRefs: [ref],
      location: { latitude: 1, longitude: 2 },
    });
    const result = applyDecryptedBody(body);
    expect(result.attachmentType).toBe('image');
    expect(result.media).toHaveLength(1);
    expect(result.location).toEqual({ latitude: 1, longitude: 2 });
  });
});
