import { MatrixSecretStorageKeyUnusableError } from '@/lib/matrix/errors';

/**
 * Answering the SDK when it needs the key to server-side secret storage.
 *
 * On web the crypto stack asks the application for this key rather than holding
 * one: every time it reads a secret out of 4S or writes one into it, it calls
 * `getSecretStorageKey` with the key descriptions the homeserver publishes in
 * account data, and expects the raw 32 bytes back. Allo answers by stretching
 * the passphrase derived from the Oxy identity with the PBKDF2 parameters that
 * the description carries — the same computation the native binding does inside
 * `recover()`, which is why one 4S store works for both platforms.
 *
 * Nothing here imports a Matrix SDK — the PBKDF2 is handed in, the same way
 * `web/cryptoWasm.ts` is handed its `initAsync`. That is what lets the checks
 * below be tested against fabricated key descriptions with no SDK, no browser
 * and no homeserver, and it is why the awkward import of
 * `deriveRecoveryKeyFromPassphrase` lives in `client.web.ts` instead.
 *
 * Writing that PBKDF2 by hand rather than borrowing the SDK's would be the wrong
 * economy: it has to agree byte for byte with what Rust computes on the other
 * platform, and the SDK's copy is the one that is known to.
 */

/** The only secret storage algorithm the spec defines, and the only one Allo reads. */
const AES_HMAC_SHA2 = 'm.secret_storage.v1.aes-hmac-sha2';

/** The only key derivation function the spec defines for passphrases. */
const PBKDF2 = 'm.pbkdf2';

/**
 * The most PBKDF2 iterations Allo will run.
 *
 * Both SDKs create keys with 500 000, so this is four times the number any
 * honest homeserver publishes. The bound is not about cryptographic strength —
 * it is about a number that arrives over the network being used as a loop count.
 * A homeserver that publishes 10⁹ cannot learn the passphrase (§3.5), but
 * without a bound it can make the app compute until the user gives up, with no
 * error and nothing on screen. With one, it gets a refusal it can be blamed for.
 *
 * There is deliberately no *lower* bound. A small count would be a real weakness
 * for a passphrase a human chose; Allo's is 256 bits of HKDF output, so
 * stretching it adds nothing that could be taken away, and a floor could only
 * ever refuse a store Allo still has to open.
 */
export const MAX_PBKDF2_ITERATIONS = 2_000_000;

/**
 * How a key says it was derived, as it actually arrives.
 *
 * The SDK types `algorithm` as the literal `"m.pbkdf2"` — which is what the spec
 * defines, and not what a homeserver is obliged to send. Typing it as `string`
 * is what makes the check below something the compiler agrees can happen,
 * instead of dead code a reviewer deletes.
 */
export interface StoredPassphraseInfo {
  readonly algorithm: string;
  readonly salt: string;
  readonly iterations: number;
  readonly bits?: number;
}

/**
 * A key description as it actually arrives.
 *
 * The SDK types `passphrase` as always present; the spec does not require it,
 * and a 4S store created from a raw key has no passphrase block at all. This
 * type says what is true, and being wider than the SDK's own in both places is
 * what lets the callback be handed to it without a cast.
 */
export interface StoredSecretStorageKey {
  readonly algorithm: string;
  readonly passphrase?: StoredPassphraseInfo;
}

/** Yields the current 4S passphrase, or `undefined` when there is none to give. */
export type SecretStoragePassphraseSource = () => string | undefined;

/** The shape `matrix-js-sdk` calls, narrowed to what this port answers. */
export type SecretStorageKeyCallback = (
  opts: { keys: Record<string, StoredSecretStorageKey> },
  secretName: string,
) => Promise<[string, Uint8Array<ArrayBuffer>] | null>;

/**
 * The shape of `deriveRecoveryKeyFromPassphrase` from `matrix-js-sdk`: PBKDF2 as
 * the Matrix spec defines it for secret storage.
 */
export type RecoveryKeyDerivation = (
  passphrase: string,
  salt: string,
  iterations: number,
  numBits?: number,
) => Promise<Uint8Array<ArrayBuffer>>;

/**
 * Builds the `getSecretStorageKey` callback.
 *
 * Returns `null` — which the SDK turns into a failure of whatever needed the
 * secret — in the two cases where there is honestly no answer: no passphrase is
 * available, or no published key was created from one. It *throws* when a key
 * was created from a passphrase but describes its derivation in a way this
 * client will not run, because that is not "no answer", it is a homeserver
 * saying something wrong and the difference belongs in the logs.
 */
export function createSecretStorageKeyCallback(
  getPassphrase: SecretStoragePassphraseSource,
  derive: RecoveryKeyDerivation,
): SecretStorageKeyCallback {
  return async ({ keys }) => {
    const passphrase = getPassphrase();
    if (passphrase === undefined) {
      return null;
    }

    for (const [keyId, description] of Object.entries(keys)) {
      // A key stored under an algorithm this client does not implement, or one
      // created from a raw key rather than a passphrase. Neither is Allo's, so
      // look at the next one rather than refusing the whole account.
      if (description.algorithm !== AES_HMAC_SHA2 || description.passphrase === undefined) {
        continue;
      }

      const { algorithm, salt, iterations, bits } = description.passphrase;
      if (algorithm !== PBKDF2) {
        throw new MatrixSecretStorageKeyUnusableError(
          keyId,
          `it says its key is derived with "${algorithm}", and the only ` +
            `derivation Matrix defines is ${PBKDF2}`,
        );
      }
      if (!Number.isInteger(iterations) || iterations <= 0 || iterations > MAX_PBKDF2_ITERATIONS) {
        throw new MatrixSecretStorageKeyUnusableError(
          keyId,
          `it asks for ${iterations} PBKDF2 iterations, and this client runs at ` +
            `most ${MAX_PBKDF2_ITERATIONS}`,
        );
      }

      // Half a second of CPU on a phone, once. The salt and the iteration count
      // are the server's; the passphrase never leaves this process.
      return [keyId, await derive(passphrase, salt, iterations, bits)];
    }

    return null;
  };
}
