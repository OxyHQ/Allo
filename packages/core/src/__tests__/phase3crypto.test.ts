import { describe, expect, it } from "vitest";
import { ARCHIVE_CHUNK_MAX_BYTES, BACKUP_KDF_SALT, BACKUP_KEY_CHECK_MESSAGE, HISTORY_KEY_SEAL_INFO, archiveChunkAad } from "@allo/shared-types";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { expand, extract } from "@noble/hashes/hkdf.js";
import { mnemonicToEntropy } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { decryptArchive, encryptArchive, generateArchiveKey } from "../crypto/archive";
import { backupKeyCheck, backupKeyMatches, canonicalRecoveryPhrase, deriveBackupKey, generateRecoveryPhrase, normalizeRecoveryPhrase, validateRecoveryPhrase } from "../crypto/backupKey";
import { generateTransferKey, openWith, sealTo, transferKeyFromSecret } from "../crypto/transfer";
import { DecryptError, RecoveryPhraseError } from "../errors";
import { base64Decode, bytesEqual, bytesInclude, randomBytes, utf8Encode } from "../util/bytes";

describe("transfer key (HPKE seal / open)", () => {
  it("round-trips a 32-byte key and refuses the wrong recipient, a tampered box and another info", async () => {
    const alice = generateTransferKey();
    const bob = generateTransferKey();
    expect(alice.secretKey.length).toBe(32);
    expect(alice.publicKey.length).toBe(32);
    const key = randomBytes(32);
    const sealed = await sealTo(bob.publicKey, key, HISTORY_KEY_SEAL_INFO);
    expect(sealed.length).toBe(32 + 32 + 16);
    expect(bytesInclude(sealed, key)).toBe(false);
    expect(bytesEqual(await openWith(bob.secretKey, sealed, HISTORY_KEY_SEAL_INFO), key)).toBe(true);
    await expect(openWith(alice.secretKey, sealed, HISTORY_KEY_SEAL_INFO)).rejects.toBeInstanceOf(DecryptError);
    await expect(openWith(bob.secretKey, sealed, "other-info")).rejects.toBeInstanceOf(DecryptError);
    const tampered = new Uint8Array(sealed);
    tampered[40] ^= 1;
    await expect(openWith(bob.secretKey, tampered, HISTORY_KEY_SEAL_INFO)).rejects.toBeInstanceOf(DecryptError);
    // the public key derived from a stored secret is the one that was registered
    expect(bytesEqual(transferKeyFromSecret(bob.secretKey).publicKey, bob.publicKey)).toBe(true);
    // two seals of the same key differ (fresh ephemeral KEM key each time)
    const again = await sealTo(bob.publicKey, key, HISTORY_KEY_SEAL_INFO);
    expect(bytesEqual(again, sealed)).toBe(false);
  });
});

describe("archive chunk encryption", () => {
  it("splits at the chunk bound, binds index/total in the AAD, and refuses reorder, drop and duplication", () => {
    const key = generateArchiveKey();
    const plaintext = new Uint8Array(10_000).map((_, i) => (i * 31) & 0xff);
    const chunks = encryptArchive(key, plaintext, 4096);
    expect(chunks).toHaveLength(3);
    expect(chunks[0].length).toBe(12 + 4096 + 16);
    expect(chunks[2].length).toBe(12 + (10_000 - 8192) + 16);
    for (const c of chunks) expect(bytesInclude(c, plaintext.subarray(0, 64))).toBe(false);
    expect(bytesEqual(decryptArchive(key, chunks), plaintext)).toBe(true);
    expect(() => decryptArchive(key, [chunks[1], chunks[0], chunks[2]])).toThrow(DecryptError);
    expect(() => decryptArchive(key, [chunks[0], chunks[1]])).toThrow(DecryptError);
    expect(() => decryptArchive(key, [chunks[0], chunks[1], chunks[2], chunks[2]])).toThrow(DecryptError);
    expect(() => decryptArchive(randomBytes(32), chunks)).toThrow(DecryptError);
    const tampered = chunks.map((c) => new Uint8Array(c));
    tampered[1][20] ^= 0x80;
    expect(() => decryptArchive(key, tampered)).toThrow(DecryptError);
    // an empty archive is still one chunk
    const empty = encryptArchive(key, new Uint8Array());
    expect(empty).toHaveLength(1);
    expect(decryptArchive(key, empty).length).toBe(0);
    // the AAD rule of the contract
    expect(archiveChunkAad(0, 3)).toBe("allo-archive-v1:0/3");
    expect(ARCHIVE_CHUNK_MAX_BYTES).toBe(4 * 1024 * 1024);
  });
});

describe("recovery phrase and backup key", () => {
  it("generates a valid 12-word English phrase; derivation matches the contract's HKDF spelled out by hand", () => {
    const phrase = generateRecoveryPhrase();
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(true);
    expect(validateRecoveryPhrase("  " + phrase.toUpperCase().replace(/ /g, "   ") + "\n")).toBe(true);
    expect(canonicalRecoveryPhrase(phrase.toUpperCase())).toBe(phrase);
    expect(normalizeRecoveryPhrase(" A  b\tc ")).toBe("a b c");
    const key = deriveBackupKey(phrase, "acc-1");
    expect(key.length).toBe(32);
    const entropy = mnemonicToEntropy(phrase, wordlist);
    expect(entropy.length).toBe(16);
    const expected = expand(sha256, extract(sha256, entropy, utf8Encode(BACKUP_KDF_SALT)), utf8Encode("acc-1"), 32);
    expect(bytesEqual(key, expected)).toBe(true);
    // bound to the account: another account id, another key
    expect(bytesEqual(deriveBackupKey(phrase, "acc-2"), key)).toBe(false);
    // key check as specified
    const check = backupKeyCheck(key);
    expect(bytesEqual(base64Decode(check), hmac(sha256, key, utf8Encode(BACKUP_KEY_CHECK_MESSAGE)))).toBe(true);
    expect(backupKeyMatches(key, check)).toBe(true);
    expect(backupKeyMatches(deriveBackupKey(generateRecoveryPhrase(), "acc-1"), check)).toBe(false);
    expect(backupKeyMatches(key, "not base64!")).toBe(false);
  });

  it("refuses a phrase that is not BIP39: wrong word count, unknown word, bad checksum", () => {
    expect(validateRecoveryPhrase("abandon abandon abandon")).toBe(false);
    expect(validateRecoveryPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon zzzz")).toBe(false);
    // 12 valid words with a wrong checksum word
    expect(validateRecoveryPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon")).toBe(false);
    expect(validateRecoveryPhrase("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about")).toBe(true);
    expect(() => deriveBackupKey("abandon abandon abandon", "acc")).toThrow(RecoveryPhraseError);
    // a 24-word phrase is valid BIP39 but not an Allo recovery phrase
    const twentyFour = Array(23).fill("abandon").join(" ") + " art";
    expect(validateRecoveryPhrase(twentyFour)).toBe(false);
  });
});
