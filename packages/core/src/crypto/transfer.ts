/**
 * The instance TRANSFER key: an X25519 keypair, one per installation, whose
 * public half is registered with the instance (`transferPublicKey`) and whose
 * private half never leaves the host's `SecretStore`. A donor instance seals
 * an archive key to it with HPKE (base mode, DHKEM(X25519, HKDF-SHA256),
 * HKDF-SHA256, AES-128-GCM — the noble suite MLS already runs on), and only
 * the holder of the private key can open it. The server relays the sealed
 * key and learns nothing from it.
 *
 * Sealed form: `enc || ct`, where `enc` is the 32-byte KEM encapsulation and
 * `ct` the AEAD ciphertext (plaintext + 16-byte tag). `info` is the caller's
 * domain separator ({@link HISTORY_KEY_SEAL_INFO} for a history offer).
 */
import { x25519 } from "@noble/curves/ed25519.js";
import { DecryptError, InvalidStateError } from "../errors";
import { concatBytes } from "../util/bytes";
import { createNobleHpkeSuite } from "./nobleCryptoProvider";

export const TRANSFER_KEY_BYTES = 32;
const ENC_BYTES = 32;
const TAG_BYTES = 16;

export interface TransferKeyPair {
  /** 32-byte raw X25519 secret. */
  secretKey: Uint8Array;
  /** 32-byte raw X25519 public key. */
  publicKey: Uint8Array;
}

export function transferKeyName(accountId: string, appId: string): string {
  return `allo.transfer-key.${accountId}.${appId}`;
}

export function generateTransferKey(): TransferKeyPair {
  const { secretKey, publicKey } = x25519.keygen();
  return { secretKey, publicKey };
}

export function transferKeyFromSecret(secretKey: Uint8Array): TransferKeyPair {
  if (secretKey.length !== TRANSFER_KEY_BYTES) throw new InvalidStateError("transfer key must be 32 bytes");
  return { secretKey, publicKey: x25519.getPublicKey(secretKey) };
}

const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
const utf8 = new TextEncoder();

/** HPKE-seals `plaintext` to a raw 32-byte X25519 public key. Returns `enc || ct`. */
export async function sealTo(recipientPublicKey: Uint8Array, plaintext: Uint8Array, info: string): Promise<Uint8Array> {
  if (recipientPublicKey.length !== TRANSFER_KEY_BYTES) throw new InvalidStateError("recipient transfer key must be 32 bytes");
  const suite = createNobleHpkeSuite();
  const pk = await suite.kem.deserializePublicKey(ab(recipientPublicKey));
  const { enc, ct } = await suite.seal({ recipientPublicKey: pk, info: ab(utf8.encode(info)) }, ab(plaintext));
  return concatBytes(new Uint8Array(enc), new Uint8Array(ct));
}

/** The inverse of {@link sealTo}. Throws {@link DecryptError} on anything the key does not open. */
export async function openWith(secretKey: Uint8Array, sealed: Uint8Array, info: string): Promise<Uint8Array> {
  if (secretKey.length !== TRANSFER_KEY_BYTES) throw new InvalidStateError("transfer key must be 32 bytes");
  if (sealed.length < ENC_BYTES + TAG_BYTES) throw new DecryptError("sealed key is too short");
  const suite = createNobleHpkeSuite();
  try {
    const sk = await suite.kem.deserializePrivateKey(ab(secretKey));
    const opened = await suite.open(
      { recipientKey: sk, enc: ab(sealed.subarray(0, ENC_BYTES)), info: ab(utf8.encode(info)) },
      ab(sealed.subarray(ENC_BYTES)),
    );
    return new Uint8Array(opened);
  } catch (cause) {
    throw new DecryptError("sealed key did not open with this transfer key", { cause });
  }
}
