import { MatrixSecretStorageKeyUnusableError } from '@/lib/matrix/errors';
import {
  MAX_PBKDF2_ITERATIONS,
  createSecretStorageKeyCallback,
  type StoredSecretStorageKey,
} from '@/lib/matrix/web/secretStorage';

/**
 * The callback the web crypto stack asks for the secret storage key with.
 *
 * Everything it is handed comes from the homeserver, which makes this a boundary
 * and not an internal call. The homeserver cannot learn the passphrase — it
 * never sees it — but it decides the salt and the iteration count, and an
 * unchecked iteration count is a loop bound taken from a stranger.
 */

const AES = 'm.secret_storage.v1.aes-hmac-sha2';
const PASSPHRASE = 'derived-passphrase';

/** Stands in for PBKDF2, so a test costs microseconds instead of half a second. */
function recordingDerivation() {
  const calls: { passphrase: string; salt: string; iterations: number; bits?: number }[] = [];
  return {
    calls,
    derive: async (
      passphrase: string,
      salt: string,
      iterations: number,
      bits?: number,
    ): Promise<Uint8Array<ArrayBuffer>> => {
      calls.push({ passphrase, salt, iterations, bits });
      return new Uint8Array(32);
    },
  };
}

function passphraseKey(overrides: Partial<StoredSecretStorageKey> = {}): StoredSecretStorageKey {
  return {
    algorithm: AES,
    passphrase: { algorithm: 'm.pbkdf2', salt: 'a-random-salt', iterations: 500_000 },
    ...overrides,
  };
}

describe('createSecretStorageKeyCallback', () => {
  it('stretches the passphrase with the salt and iterations the server published', async () => {
    // Not with constants of its own: the salt is random per account and lives on
    // the server, so a client that assumed one would derive a key that opens
    // nothing.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    const result = await callback({ keys: { KEYID: passphraseKey() } }, 'm.cross_signing.master');

    expect(result).toEqual(['KEYID', new Uint8Array(32)]);
    expect(derivation.calls).toEqual([
      { passphrase: PASSPHRASE, salt: 'a-random-salt', iterations: 500_000, bits: undefined },
    ]);
  });

  it('passes the published key size through when there is one', async () => {
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    await callback(
      {
        keys: {
          KEYID: passphraseKey({
            passphrase: {
              algorithm: 'm.pbkdf2',
              salt: 'salt',
              iterations: 500_000,
              bits: 256,
            },
          }),
        },
      },
      'm.megolm_backup.v1',
    );

    expect(derivation.calls[0]?.bits).toBe(256);
  });

  it('reads the passphrase at call time, not at construction', async () => {
    // The SDK registers this callback while the client is built, long before any
    // recovery has run. A callback that captured the passphrase would answer
    // `null` forever.
    const derivation = recordingDerivation();
    let passphrase: string | undefined;
    const callback = createSecretStorageKeyCallback(() => passphrase, derivation.derive);

    expect(await callback({ keys: { KEYID: passphraseKey() } }, 'secret')).toBeNull();

    passphrase = PASSPHRASE;
    expect(await callback({ keys: { KEYID: passphraseKey() } }, 'secret')).not.toBeNull();
  });

  it('skips a key that was created from a raw key rather than a passphrase', async () => {
    // Not Allo's key. Refusing the whole account over it would be wrong; so
    // would deriving a passphrase key for a slot that has no passphrase.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    const result = await callback(
      { keys: { RAWKEY: { algorithm: AES } } },
      'm.cross_signing.master',
    );

    expect(result).toBeNull();
    expect(derivation.calls).toHaveLength(0);
  });

  it('skips a key stored under an algorithm this client does not implement', async () => {
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    const result = await callback(
      {
        keys: {
          FUTURE: { algorithm: 'm.secret_storage.v2.something', passphrase: passphraseKey().passphrase },
          OURS: passphraseKey(),
        },
      },
      'm.cross_signing.master',
    );

    expect(result?.[0]).toBe('OURS');
  });

  it('refuses a derivation function Matrix does not define', async () => {
    // The spec defines exactly one. Anything else is a homeserver saying
    // something wrong, and quietly running PBKDF2 anyway would derive a key that
    // cannot work while pretending the description was understood.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    await expect(
      callback(
        {
          keys: {
            KEYID: passphraseKey({
              passphrase: { algorithm: 'm.scrypt', salt: 'salt', iterations: 500_000 },
            }),
          },
        },
        'm.cross_signing.master',
      ),
    ).rejects.toBeInstanceOf(MatrixSecretStorageKeyUnusableError);
    expect(derivation.calls).toHaveLength(0);
  });

  it('refuses an iteration count above what it will run', async () => {
    // A number from the network used as a loop bound. Without this the app
    // computes until the user gives up, with nothing on screen and no error.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    await expect(
      callback(
        {
          keys: {
            KEYID: passphraseKey({
              passphrase: {
                algorithm: 'm.pbkdf2',
                salt: 'salt',
                iterations: MAX_PBKDF2_ITERATIONS + 1,
              },
            }),
          },
        },
        'm.cross_signing.master',
      ),
    ).rejects.toBeInstanceOf(MatrixSecretStorageKeyUnusableError);
    expect(derivation.calls).toHaveLength(0);
  });

  it('still runs the count both SDKs actually publish', async () => {
    // The bound has to leave room for the real world: 500 000 is what the Rust
    // SDK and matrix-js-sdk both create keys with.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    await callback({ keys: { KEYID: passphraseKey() } }, 'm.cross_signing.master');

    expect(derivation.calls[0]?.iterations).toBe(500_000);
    expect(MAX_PBKDF2_ITERATIONS).toBeGreaterThanOrEqual(500_000);
  });

  it('refuses an iteration count that is not a positive whole number', async () => {
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    for (const iterations of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(
        callback(
          {
            keys: {
              KEYID: passphraseKey({
                passphrase: { algorithm: 'm.pbkdf2', salt: 'salt', iterations },
              }),
            },
          },
          'm.cross_signing.master',
        ),
      ).rejects.toBeInstanceOf(MatrixSecretStorageKeyUnusableError);
    }
    expect(derivation.calls).toHaveLength(0);
  });

  it('answers null when there is no passphrase to stretch', async () => {
    // Before any recovery has run. The SDK turns this into a failure of whatever
    // wanted the secret, which is the truth.
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => undefined, derivation.derive);

    expect(await callback({ keys: { KEYID: passphraseKey() } }, 'secret')).toBeNull();
    expect(derivation.calls).toHaveLength(0);
  });

  it('answers null when the account publishes no keys at all', async () => {
    const derivation = recordingDerivation();
    const callback = createSecretStorageKeyCallback(() => PASSPHRASE, derivation.derive);

    expect(await callback({ keys: {} }, 'secret')).toBeNull();
  });

  it('never puts the passphrase in the error it raises', async () => {
    const callback = createSecretStorageKeyCallback(
      () => PASSPHRASE,
      recordingDerivation().derive,
    );

    expect.assertions(1);
    try {
      await callback(
        {
          keys: {
            KEYID: passphraseKey({
              passphrase: { algorithm: 'm.scrypt', salt: 'salt', iterations: 1 },
            }),
          },
        },
        'm.cross_signing.master',
      );
    } catch (error) {
      expect(error instanceof Error ? error.message : String(error)).not.toContain(PASSPHRASE);
    }
  });
});
