/**
 * At-rest encryption for everything the SDK persists through `StorageAdapter`.
 * AES-256-GCM with a random 32-byte key held in the host's `SecretStore`, a
 * fresh 12-byte nonce per write (prefixed to the ciphertext), and the storage
 * key path as additional data so a row cannot be moved under another key.
 */
import { gcm } from "@noble/ciphers/aes.js";
import { StorageError } from "../errors";
import { bytesEqual, concatBytes, randomBytes, utf8Encode } from "../util/bytes";
import type { SecretStore } from "../types";

export const STORAGE_KEY_BYTES = 32;
const NONCE_BYTES = 12;
const VERSION = 1;

export function storageKeyName(accountId: string, appId: string): string {
  return `allo.storage-key.${accountId}.${appId}`;
}

export class AtRestCipher {
  private constructor(
    private readonly key: Uint8Array,
    /**
     * This key was minted just now rather than read back.
     *
     * On a first run that is simply true. On a device that already has rows it
     * means the old key is GONE, and every one of those rows is ciphertext
     * nobody — not this device, not the server, not an attacker — can ever
     * read again. A caller that finds both must drop the rows rather than
     * fail on them for ever; see `client.start()`.
     */
    readonly mintedFresh: boolean,
  ) {}

  /** Loads the account's storage key, minting one when there is none to read. */
  static async open(secrets: SecretStore, accountId: string, appId: string): Promise<AtRestCipher> {
    const name = storageKeyName(accountId, appId);
    const key = await secrets.get(name);
    if (key !== undefined && key.length === STORAGE_KEY_BYTES) return new AtRestCipher(key, false);
    const fresh = randomBytes(STORAGE_KEY_BYTES);
    await secrets.set(name, fresh);
    const check = await secrets.get(name);
    if (!check || !bytesEqual(check, fresh)) throw new StorageError("secret store did not persist the storage key");
    return new AtRestCipher(fresh, true);
  }

  static fromKey(key: Uint8Array): AtRestCipher {
    if (key.length !== STORAGE_KEY_BYTES) throw new StorageError("storage key must be 32 bytes");
    return new AtRestCipher(key, false);
  }

  encrypt(storageKey: string, plaintext: Uint8Array): Uint8Array {
    const nonce = randomBytes(NONCE_BYTES);
    const ct = gcm(this.key, nonce, utf8Encode(storageKey)).encrypt(plaintext);
    return concatBytes(new Uint8Array([VERSION]), nonce, ct);
  }

  decrypt(storageKey: string, stored: Uint8Array): Uint8Array {
    if (stored.length < 1 + NONCE_BYTES + 16 || stored[0] !== VERSION) throw new StorageError("stored value is not in the at-rest format");
    const nonce = stored.subarray(1, 1 + NONCE_BYTES);
    const ct = stored.subarray(1 + NONCE_BYTES);
    try {
      return gcm(this.key, nonce, utf8Encode(storageKey)).decrypt(ct);
    } catch (cause) {
      throw new StorageError("stored value failed authentication", { cause });
    }
  }
}
