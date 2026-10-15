import { frameKeyPassphrase } from './frameKey';
import { RNKeyProvider, RNE2EEManager } from '@livekit/react-native';
import type { RoomOptions } from 'livekit-client';
export function createEncryption() {
  const keys = new RNKeyProvider({
    sharedKey: false,
    keySize: 128,
    ratchetWindowSize: 0,
    failureTolerance: -1,
    uncryptedMagicBytes: new Uint8Array(),
  });
  const manager = new RNE2EEManager(keys);
  return {
    options: { encryption: { e2eeManager: manager } } satisfies RoomOptions,
    setKey: async (id: string, bytes: Uint8Array) => {
      if (!(await keys.setKey(id, frameKeyPassphrase(bytes), 0)))
        throw new Error('native call encryption key was refused');
    },
    dispose: () => keys.dispose(),
  };
}
