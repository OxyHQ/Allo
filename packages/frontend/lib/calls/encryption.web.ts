import { frameKeyPassphrase } from './frameKey';
import { BaseKeyProvider, isE2EESupported, type RoomOptions } from 'livekit-client';
class SenderKeys extends BaseKeyProvider {
  constructor() {
    super({ sharedKey: false, ratchetWindowSize: 0, failureTolerance: -1, keySize: 128 });
  }
  async setKey(id: string, bytes: Uint8Array) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(frameKeyPassphrase(bytes)),
      'PBKDF2',
      false,
      ['deriveBits', 'deriveKey'],
    );
    this.onSetEncryptionKey(key, id, 0);
  }
}
export function createEncryption() {
  if (!isE2EESupported()) throw new Error('encrypted group calls are unsupported by this browser');
  const keys = new SenderKeys();
  const worker = new Worker('/call-encryption.worker.js');
  return {
    options: { encryption: { keyProvider: keys, worker } } satisfies RoomOptions,
    setKey: (id: string, bytes: Uint8Array) => keys.setKey(id, bytes),
    dispose: () => worker.terminate(),
  };
}
