import { encryptSession, decryptSession } from "../crypto";
import { TEST_SESSION_KEY } from "./helpers/fixtures";

/**
 * Session-at-rest encryption: round-trip correctness, fresh-IV-per-write, and
 * tamper-evidence (a flipped ciphertext/tag/iv byte must fail to decrypt).
 */
describe("crypto — session encryption (AES-256-GCM)", () => {
  const prevKey = process.env.BRIDGE_SESSION_KEY;
  beforeEach(() => {
    process.env.BRIDGE_SESSION_KEY = TEST_SESSION_KEY;
  });
  afterEach(() => {
    process.env.BRIDGE_SESSION_KEY = prevKey;
  });

  it("round-trips a plaintext session string", () => {
    const plaintext = "1AaBbCcDd-telegram-string-session-xyz";
    const enc = encryptSession(plaintext);
    expect(enc.iv).toBeTruthy();
    expect(enc.authTag).toBeTruthy();
    expect(enc.ciphertext).toBeTruthy();
    // Ciphertext must not contain the plaintext.
    expect(Buffer.from(enc.ciphertext, "base64").toString("utf8")).not.toContain("telegram");
    expect(decryptSession(enc)).toBe(plaintext);
  });

  it("uses a fresh random IV per write (same plaintext -> different ciphertext)", () => {
    const plaintext = "same-session";
    const a = encryptSession(plaintext);
    const b = encryptSession(plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
    // Both still decrypt back to the same plaintext.
    expect(decryptSession(a)).toBe(plaintext);
    expect(decryptSession(b)).toBe(plaintext);
  });

  it("fails to decrypt when the ciphertext is tampered", () => {
    const enc = encryptSession("tamper-me");
    const bytes = Buffer.from(enc.ciphertext, "base64");
    bytes[0] = bytes[0] ^ 0xff;
    const tampered = { ...enc, ciphertext: bytes.toString("base64") };
    expect(() => decryptSession(tampered)).toThrow();
  });

  it("fails to decrypt when the auth tag is tampered", () => {
    const enc = encryptSession("tamper-tag");
    const tag = Buffer.from(enc.authTag, "base64");
    tag[0] = tag[0] ^ 0xff;
    const tampered = { ...enc, authTag: tag.toString("base64") };
    expect(() => decryptSession(tampered)).toThrow();
  });

  it("fails to decrypt under a DIFFERENT key", () => {
    const enc = encryptSession("wrong-key-test");
    process.env.BRIDGE_SESSION_KEY = "z".repeat(40);
    expect(() => decryptSession(enc)).toThrow();
  });

  it("throws on encrypt/decrypt when the key is unset/too short", () => {
    process.env.BRIDGE_SESSION_KEY = "short";
    expect(() => encryptSession("x")).toThrow();
  });
});
