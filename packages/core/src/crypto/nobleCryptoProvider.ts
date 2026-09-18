/**
 * A ts-mls `CryptoProvider` for MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
 * that never touches `crypto.subtle`. It is the DEFAULT provider on every
 * platform, deliberately: WebCrypto exists on web and not on Hermes, and a
 * provider split by platform would leave the two with different private-key
 * formats (WebCrypto stores an Ed25519 key as 48-byte PKCS#8, noble as 32
 * raw bytes; `spikes/mls/RESULTS.md` section 5 measured a state written by
 * one refusing to sign under the other). One provider means one key format,
 * one persisted-state format, and one code path to audit. The only platform
 * primitive it needs is `crypto.getRandomValues`.
 *
 * Pieces:
 *  - hash / HMAC ............ @noble/hashes
 *  - HKDF (HPKE KdfInterface) @noble/hashes, subclassing @hpke/common's
 *                              HkdfSha256Native so the labeled* helpers stay the library's
 *  - KEM .................... @hpke/common Dhkem + @hpke/dhkem-x25519's X25519 primitive (noble)
 *  - AEAD ................... @noble/ciphers AES-128-GCM as an @hpke AeadInterface
 *  - HPKE glue .............. a copy of ts-mls's `makeGenericHpke` (its subpath is not
 *                              resolvable under this package's module resolution)
 *  - signature .............. @noble/curves ed25519 (raw 32-byte secret keys)
 *  - rng .................... crypto.getRandomValues
 */
import { CipherSuite } from "@hpke/core";
import {
  AeadId,
  Dhkem,
  HkdfSha256Native,
  KemId,
  toArrayBuffer,
  type AeadEncryptionContext,
  type AeadInterface,
} from "@hpke/common";
import { X25519 } from "@hpke/dhkem-x25519";
import { gcm } from "@noble/ciphers/aes.js";
import { ed25519 } from "@noble/curves/ed25519.js";
import { expand as hkdfExpand, extract as hkdfExtract } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { Ciphersuite, CiphersuiteImpl, CryptoProvider, Hash, Hpke, Kdf, PrivateKey, PublicKey, Rng, Signature } from "ts-mls";
import { randomBytes } from "../util/bytes";

export const NOBLE_SUITE_NAME = "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519";

const u8 = (b: ArrayBufferLike | ArrayBufferView) => new Uint8Array(toArrayBuffer(b));
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

/** HPKE KdfInterface (HKDF-SHA256) with no WebCrypto. */
class NobleHkdfSha256 extends HkdfSha256Native {
  override async _setup(): Promise<void> {
    /* never load subtle */
  }
  override async extract(salt: ArrayBufferLike | ArrayBufferView, ikm: ArrayBufferLike | ArrayBufferView): Promise<ArrayBuffer> {
    const s = u8(salt);
    return ab(hmac(sha256, s.byteLength === 0 ? new Uint8Array(this.hashSize) : s, u8(ikm)));
  }
  override async expand(prk: ArrayBufferLike | ArrayBufferView, info: ArrayBufferLike | ArrayBufferView, len: number): Promise<ArrayBuffer> {
    return ab(hkdfExpand(sha256, u8(prk), u8(info), len));
  }
  override async extractAndExpand(
    salt: ArrayBufferLike | ArrayBufferView,
    ikm: ArrayBufferLike | ArrayBufferView,
    info: ArrayBufferLike | ArrayBufferView,
    len: number,
  ): Promise<ArrayBuffer> {
    return ab(hkdfExpand(sha256, hkdfExtract(sha256, u8(ikm), u8(salt)), u8(info), len));
  }
}

/** DHKEM(X25519, HKDF-SHA256) whose internal KDF is the noble one. */
class NobleDhkemX25519 extends Dhkem {
  override id = KemId.DhkemX25519HkdfSha256;
  override secretSize = 32;
  override encSize = 32;
  override publicKeySize = 32;
  override privateKeySize = 32;
  constructor() {
    const kdf = new NobleHkdfSha256();
    super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf);
  }
}

/** AES-128-GCM as an @hpke AeadInterface over @noble/ciphers. */
class NobleAes128Gcm implements AeadInterface {
  readonly id = AeadId.Aes128Gcm;
  readonly keySize = 16;
  readonly nonceSize = 12;
  readonly tagSize = 16;
  createEncryptionContext(key: ArrayBufferLike | ArrayBufferView): AeadEncryptionContext {
    const k = u8(key);
    return {
      async seal(iv, data, aad) {
        return ab(gcm(k, u8(iv), u8(aad)).encrypt(u8(data)));
      },
      async open(iv, data, aad) {
        return ab(gcm(k, u8(iv), u8(aad)).decrypt(u8(data)));
      },
    };
  }
}

const hash: Hash = {
  async digest(data) {
    return sha256(data);
  },
  async mac(key, data) {
    return hmac(sha256, key, data);
  },
  async verifyMac(key, mac, data) {
    const expected = hmac(sha256, key, data);
    if (expected.length !== mac.length) return false;
    let diff = 0;
    for (let i = 0; i < mac.length; i++) diff |= mac[i]! ^ expected[i]!;
    return diff === 0;
  },
};

const kdf: Kdf = {
  async extract(salt, ikm) {
    return hkdfExtract(sha256, ikm, salt);
  },
  async expand(prk, info, len) {
    return hkdfExpand(sha256, prk, info, len);
  },
  size: 32,
};

const signature: Signature = {
  async sign(signKey, message) {
    return ed25519.sign(message, signKey);
  },
  async verify(publicKey, message, sig) {
    try {
      return ed25519.verify(sig, message, publicKey);
    } catch {
      return false;
    }
  },
  async keygen() {
    const signKey = ed25519.utils.randomSecretKey();
    return { signKey, publicKey: ed25519.getPublicKey(signKey) };
  },
};

const rng: Rng = {
  randomBytes(n) {
    return randomBytes(n);
  },
};

class AeadFailure extends Error {
  override readonly name = "CryptoError";
}

/** ts-mls's `Hpke` over an @hpke `CipherSuite` plus a raw AEAD. Mirrors `ts-mls/crypto/implementation/hpke.js`. */
function makeHpke(cs: CipherSuite): Hpke {
  const wrap = (e: unknown) => new AeadFailure(String(e));
  return {
    async open(privateKey, kemOutput, ciphertext, info, aad) {
      try {
        const result = await cs.open(
          { recipientKey: privateKey, enc: ab(kemOutput), info: ab(info) },
          ab(ciphertext),
          aad ? ab(aad) : new ArrayBuffer(0),
        );
        return new Uint8Array(result);
      } catch (e) {
        throw wrap(e);
      }
    },
    async seal(publicKey, plaintext, info, aad) {
      const result = await cs.seal({ recipientPublicKey: publicKey, info: ab(info) }, ab(plaintext), aad ? ab(aad) : new ArrayBuffer(0));
      return { ct: new Uint8Array(result.ct), enc: new Uint8Array(result.enc) };
    },
    async exportSecret(publicKey, exporterContext, length, info) {
      const context = await cs.createSenderContext({ recipientPublicKey: publicKey, info: ab(info) });
      return { enc: new Uint8Array(context.enc), secret: new Uint8Array(await context.export(ab(exporterContext), length)) };
    },
    async importSecret(privateKey, exporterContext, kemOutput, length, info) {
      try {
        const context = await cs.createRecipientContext({ recipientKey: privateKey, info: ab(info), enc: ab(kemOutput) });
        return new Uint8Array(await context.export(ab(exporterContext), length));
      } catch (e) {
        throw wrap(e);
      }
    },
    async importPrivateKey(k) {
      try {
        return (await cs.kem.deserializePrivateKey(ab(k))) as PrivateKey;
      } catch (e) {
        throw wrap(e);
      }
    },
    async importPublicKey(k) {
      try {
        return (await cs.kem.deserializePublicKey(ab(k))) as PublicKey;
      } catch (e) {
        throw wrap(e);
      }
    },
    async exportPublicKey(k) {
      return new Uint8Array(await cs.kem.serializePublicKey(k));
    },
    async exportPrivateKey(k) {
      return new Uint8Array(await cs.kem.serializePrivateKey(k));
    },
    async encryptAead(key, nonce, aad, plaintext) {
      return gcm(key, nonce, aad ?? new Uint8Array()).encrypt(plaintext);
    },
    async decryptAead(key, nonce, aad, ciphertext) {
      try {
        return gcm(key, nonce, aad ?? new Uint8Array()).decrypt(ciphertext);
      } catch (e) {
        throw wrap(e);
      }
    },
    async deriveKeyPair(ikm) {
      const kp = await cs.kem.deriveKeyPair(ab(ikm));
      return { privateKey: kp.privateKey as PrivateKey, publicKey: kp.publicKey as PublicKey };
    },
    async generateKeyPair() {
      const kp = await cs.kem.generateKeyPair();
      return { privateKey: kp.privateKey as PrivateKey, publicKey: kp.publicKey as PublicKey };
    },
    keyLength: cs.aead.keySize,
    nonceLength: cs.aead.nonceSize,
  } as Hpke;
}

/**
 * The HPKE suite DHKEM(X25519, HKDF-SHA256) / HKDF-SHA256 / AES-128-GCM over
 * noble only. MLS uses it through {@link nobleCryptoProvider}; the history
 * transfer (`crypto/transfer.ts`) uses it directly to seal an archive key.
 */
export function createNobleHpkeSuite(): CipherSuite {
  return new CipherSuite({ kem: new NobleDhkemX25519(), kdf: new NobleHkdfSha256(), aead: new NobleAes128Gcm() });
}

export const nobleCryptoProvider: CryptoProvider = {
  async getCiphersuiteImpl(cs: Ciphersuite): Promise<CiphersuiteImpl> {
    if (cs.name !== NOBLE_SUITE_NAME) throw new Error(`nobleCryptoProvider: unsupported suite ${cs.name}`);
    const suite = createNobleHpkeSuite();
    return { hash, kdf, signature, hpke: makeHpke(suite), rng, name: cs.name };
  },
};
