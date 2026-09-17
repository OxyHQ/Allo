/**
 * A ts-mls `CryptoProvider` for MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519
 * that never touches `crypto.subtle`. This is the shape an Allo React Native
 * (Hermes) build would ship: every primitive comes from @noble/* or the
 * noble-based @hpke/dhkem-x25519, and the only global it needs is
 * `crypto.getRandomValues` (react-native-get-random-values / expo-crypto).
 *
 * Pieces:
 *  - hash / HMAC ............ @noble/hashes
 *  - HKDF (HPKE KdfInterface) @noble/hashes hmac, subclassing @hpke/common's
 *                              HkdfSha256Native so the labeled* helpers and
 *                              the suite-id bookkeeping stay the library's
 *  - KEM .................... @hpke/common Dhkem + @hpke/dhkem-x25519 X25519
 *                              primitive (noble), wired to the noble HKDF
 *  - AEAD ................... @noble/ciphers AES-128-GCM as an @hpke AeadInterface
 *  - HPKE glue .............. ts-mls's own makeGenericHpke over an @hpke/core CipherSuite
 *  - signature .............. @noble/curves ed25519
 *  - rng .................... crypto.getRandomValues
 */
import { CipherSuite } from "@hpke/core"
import { AeadId, Dhkem, HkdfSha256Native, KemId, toArrayBuffer, type AeadInterface, type AeadEncryptionContext } from "@hpke/common"
import { X25519 } from "@hpke/dhkem-x25519"
import { hmac } from "@noble/hashes/hmac.js"
import { sha256 } from "@noble/hashes/sha2.js"
import { extract as hkdfExtract, expand as hkdfExpand } from "@noble/hashes/hkdf.js"
import { gcm } from "@noble/ciphers/aes.js"
import { ed25519 } from "@noble/curves/ed25519.js"
import { makeGenericHpke } from "ts-mls/crypto/implementation/hpke.js"
import type { CryptoProvider, CiphersuiteImpl, Ciphersuite, Hash, Kdf, Signature, Rng } from "ts-mls"
import type { Aead } from "ts-mls/crypto/aead.js"

const u8 = (b: ArrayBufferLike | ArrayBufferView) => new Uint8Array(toArrayBuffer(b))
const ab = (b: Uint8Array): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer

/** HPKE KdfInterface (HKDF-SHA256) with no WebCrypto. */
class NobleHkdfSha256 extends HkdfSha256Native {
  override async _setup() {
    /* never load subtle */
  }
  override async extract(salt: ArrayBufferLike | ArrayBufferView, ikm: ArrayBufferLike | ArrayBufferView): Promise<ArrayBuffer> {
    const s = u8(salt)
    return ab(hmac(sha256, s.byteLength === 0 ? new Uint8Array(this.hashSize) : s, u8(ikm)))
  }
  override async expand(prk: ArrayBufferLike | ArrayBufferView, info: ArrayBufferLike | ArrayBufferView, len: number): Promise<ArrayBuffer> {
    return ab(hkdfExpand(sha256, u8(prk), u8(info), len))
  }
  override async extractAndExpand(salt: ArrayBufferLike | ArrayBufferView, ikm: ArrayBufferLike | ArrayBufferView, info: ArrayBufferLike | ArrayBufferView, len: number): Promise<ArrayBuffer> {
    return ab(hkdfExpand(sha256, hkdfExtract(sha256, u8(ikm), u8(salt)), u8(info), len))
  }
}

/** DHKEM(X25519, HKDF-SHA256) whose internal KDF is the noble one. */
class NobleDhkemX25519 extends Dhkem {
  override id = KemId.DhkemX25519HkdfSha256
  override secretSize = 32
  override encSize = 32
  override publicKeySize = 32
  override privateKeySize = 32
  constructor() {
    const kdf = new NobleHkdfSha256()
    super(KemId.DhkemX25519HkdfSha256, new X25519(kdf), kdf)
  }
}

/** AES-128-GCM as an @hpke AeadInterface over @noble/ciphers. */
class NobleAes128Gcm implements AeadInterface {
  readonly id = AeadId.Aes128Gcm
  readonly keySize = 16
  readonly nonceSize = 12
  readonly tagSize = 16
  createEncryptionContext(key: ArrayBufferLike | ArrayBufferView): AeadEncryptionContext {
    const k = u8(key)
    return {
      async seal(iv, data, aad) {
        return ab(gcm(k, u8(iv), u8(aad)).encrypt(u8(data)))
      },
      async open(iv, data, aad) {
        return ab(gcm(k, u8(iv), u8(aad)).decrypt(u8(data)))
      },
    }
  }
}

const hash: Hash = {
  async digest(data) {
    return sha256(data)
  },
  async mac(key, data) {
    return hmac(sha256, key, data)
  },
  async verifyMac(key, mac, data) {
    const expected = hmac(sha256, key, data)
    if (expected.length !== mac.length) return false
    let diff = 0
    for (let i = 0; i < mac.length; i++) diff |= mac[i]! ^ expected[i]!
    return diff === 0
  },
}

const kdf: Kdf = {
  async extract(salt, ikm) {
    return hkdfExtract(sha256, ikm, salt)
  },
  async expand(prk, info, len) {
    return hkdfExpand(sha256, prk, info, len)
  },
  size: 32,
}

const signature: Signature = {
  async sign(signKey, message) {
    return ed25519.sign(message, signKey)
  },
  async verify(publicKey, message, sig) {
    try {
      return ed25519.verify(sig, message, publicKey)
    } catch {
      return false
    }
  },
  async keygen() {
    const signKey = ed25519.utils.randomSecretKey()
    return { signKey, publicKey: ed25519.getPublicKey(signKey) }
  },
}

const rng: Rng = {
  randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n))
  },
}

const aead: Aead = {
  async encrypt(key, nonce, aad, plaintext) {
    return gcm(key, nonce, aad).encrypt(plaintext)
  },
  async decrypt(key, nonce, aad, ciphertext) {
    return gcm(key, nonce, aad).decrypt(ciphertext)
  },
}

export const nobleOnlyProvider: CryptoProvider = {
  async getCiphersuiteImpl(cs: Ciphersuite): Promise<CiphersuiteImpl> {
    if (cs.name !== "MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519") throw new Error(`nobleOnlyProvider: unsupported suite ${cs.name}`)
    const suite = new CipherSuite({ kem: new NobleDhkemX25519(), kdf: new NobleHkdfSha256(), aead: new NobleAes128Gcm() })
    const hpke = await makeGenericHpke(cs.hpke, aead, suite)
    return { hash, kdf, signature, hpke, rng, name: cs.name }
  },
}
