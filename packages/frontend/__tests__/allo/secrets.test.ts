import { SecureStoreSecrets, secureStoreKey, type SecureStoreLike } from '@/lib/allo/secrets.native';

/**
 * The Keychain/Keystore secret store, against a fake `expo-secure-store` that
 * records what it was asked. Two properties: bytes survive the base64 round
 * trip untouched (a storage key with one flipped bit decrypts nothing), and
 * every write asks for `WHEN_UNLOCKED_THIS_DEVICE_ONLY` — the option that
 * keeps a signing key out of backups and off other devices.
 */

jest.mock('expo-secure-store', () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

class FakeSecureStore implements SecureStoreLike {
  values = new Map<string, string>();
  options: unknown[] = [];

  async getItemAsync(key: string, options?: unknown): Promise<string | null> {
    this.options.push(options);
    return this.values.get(key) ?? null;
  }
  async setItemAsync(key: string, value: string, options?: unknown): Promise<void> {
    this.options.push(options);
    this.values.set(key, value);
  }
  async deleteItemAsync(key: string, options?: unknown): Promise<void> {
    this.options.push(options);
    this.values.delete(key);
  }
}

describe('secureStoreKey', () => {
  it('keeps the characters the Keychain accepts and replaces the rest', () => {
    expect(secureStoreKey('allo.instance-key.acc_1.allo')).toBe('allo.instance-key.acc_1.allo');
    expect(secureStoreKey('a/b c')).toBe('a_b_c');
  });
});

describe('SecureStoreSecrets', () => {
  it('round-trips arbitrary bytes, including zeros and high bits', async () => {
    const store = new FakeSecureStore();
    const secrets = new SecureStoreSecrets(store);
    const value = new Uint8Array(32);
    for (let i = 0; i < value.length; i++) value[i] = (i * 37 + 11) & 0xff;
    value[0] = 0;
    value[31] = 0xff;

    await secrets.set('allo.storage-key.acc.allo', value);
    const back = await secrets.get('allo.storage-key.acc.allo');

    expect(back).toEqual(value);
    // What the Keychain holds is text, not the bytes.
    expect(typeof store.values.get('allo.storage-key.acc.allo')).toBe('string');
  });

  it('answers undefined for a name that was never set, and after delete', async () => {
    const secrets = new SecureStoreSecrets(new FakeSecureStore());
    expect(await secrets.get('nothing')).toBeUndefined();
    await secrets.set('k', new Uint8Array([1, 2, 3]));
    await secrets.delete('k');
    expect(await secrets.get('k')).toBeUndefined();
  });

  it('asks for WHEN_UNLOCKED_THIS_DEVICE_ONLY on every call', async () => {
    const store = new FakeSecureStore();
    const secrets = new SecureStoreSecrets(store);
    await secrets.set('k', new Uint8Array([9]));
    await secrets.get('k');
    await secrets.delete('k');

    expect(store.options).toHaveLength(3);
    for (const options of store.options) {
      expect(options).toEqual({ keychainAccessible: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY' });
    }
  });
});
