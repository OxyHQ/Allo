import {
  validateEncryptedMessage,
  validateWireCiphertext,
  isEncrypted,
  getMessagePreview,
} from "../utils/signalProtocol";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const VALID_V2_PAYLOAD = {
  v: 2,
  dh: Buffer.from("dh-public-key-bytes").toString("base64"),
  pn: 0,
  n: 3,
  ct: Buffer.from("nonce-and-aead-ciphertext").toString("base64"),
};

const VALID_V2_PAYLOAD_WITH_X3DH = {
  ...VALID_V2_PAYLOAD,
  x3dh: {
    ek: Buffer.from("ephemeral").toString("base64"),
    ikE: Buffer.from("identity-ed").toString("base64"),
    ikD: Buffer.from("identity-dh").toString("base64"),
    spk: 1,
    opk: 7,
  },
};

describe("validateWireCiphertext", () => {
  it("accepts a well-formed v2 payload", () => {
    expect(validateWireCiphertext(b64(VALID_V2_PAYLOAD))).toBe(true);
  });

  it("accepts a v2 payload with an x3dh header", () => {
    expect(validateWireCiphertext(b64(VALID_V2_PAYLOAD_WITH_X3DH))).toBe(true);
  });

  it("rejects non-base64 input", () => {
    expect(validateWireCiphertext("not base64 !!!")).toBe(false);
    expect(validateWireCiphertext(123)).toBe(false);
    expect(validateWireCiphertext(undefined)).toBe(false);
    expect(validateWireCiphertext("")).toBe(false);
  });

  it("rejects base64 that is not JSON", () => {
    expect(
      validateWireCiphertext(Buffer.from("plain text").toString("base64"))
    ).toBe(false);
  });

  it("rejects wrong version", () => {
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, v: 1 }))).toBe(false);
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, v: 3 }))).toBe(false);
  });

  it("rejects missing or invalid fields", () => {
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, dh: undefined }))).toBe(false);
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, ct: "" }))).toBe(false);
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, pn: -1 }))).toBe(false);
    expect(validateWireCiphertext(b64({ ...VALID_V2_PAYLOAD, n: "3" }))).toBe(false);
  });

  it("rejects a malformed x3dh header", () => {
    expect(
      validateWireCiphertext(
        b64({ ...VALID_V2_PAYLOAD, x3dh: { ek: "AAAA", ikE: "AAAA" } })
      )
    ).toBe(false);
    expect(
      validateWireCiphertext(
        b64({
          ...VALID_V2_PAYLOAD,
          x3dh: { ...VALID_V2_PAYLOAD_WITH_X3DH.x3dh, spk: "1" },
        })
      )
    ).toBe(false);
  });
});

describe("validateEncryptedMessage", () => {
  it("accepts a valid v2 encrypted message", () => {
    expect(
      validateEncryptedMessage({
        ciphertext: b64(VALID_V2_PAYLOAD),
        encryptionVersion: 2,
        messageType: "text",
      })
    ).toBe(true);
  });

  it("rejects a v2 message with a malformed inner payload", () => {
    expect(
      validateEncryptedMessage({
        ciphertext: Buffer.from("garbage").toString("base64"),
        encryptionVersion: 2,
      })
    ).toBe(false);
  });

  it("keeps v1 legacy compatibility without inspecting the inner payload", () => {
    expect(
      validateEncryptedMessage({
        ciphertext: Buffer.from("opaque-legacy-blob").toString("base64"),
        encryptionVersion: 1,
      })
    ).toBe(true);
  });

  it("rejects unknown encryption versions", () => {
    expect(
      validateEncryptedMessage({
        ciphertext: b64(VALID_V2_PAYLOAD),
        encryptionVersion: 99,
      })
    ).toBe(false);
  });

  it("rejects messages without ciphertext or encrypted media", () => {
    expect(validateEncryptedMessage({})).toBe(false);
    expect(validateEncryptedMessage({ ciphertext: "" })).toBe(false);
  });

  it("rejects invalid messageType", () => {
    expect(
      validateEncryptedMessage({
        ciphertext: b64(VALID_V2_PAYLOAD),
        encryptionVersion: 2,
        messageType: "weird",
      })
    ).toBe(false);
  });

  it("validates each encrypted media item for v2", () => {
    expect(
      validateEncryptedMessage({
        encryptedMedia: [{ ciphertext: b64(VALID_V2_PAYLOAD) }],
        encryptionVersion: 2,
        messageType: "media",
      })
    ).toBe(true);

    expect(
      validateEncryptedMessage({
        encryptedMedia: [{ ciphertext: Buffer.from("junk").toString("base64") }],
        encryptionVersion: 2,
        messageType: "media",
      })
    ).toBe(false);
  });
});

describe("isEncrypted / getMessagePreview", () => {
  it("detects encrypted messages", () => {
    expect(isEncrypted({ ciphertext: "AAAA" })).toBe(true);
    expect(isEncrypted({ encryptedMedia: [{}] })).toBe(true);
    expect(isEncrypted({ text: "hola" })).toBe(false);
  });

  it("never leaks plaintext for encrypted messages", () => {
    expect(getMessagePreview({ ciphertext: "AAAA" })).toBe("[Encrypted message]");
    expect(getMessagePreview({ encryptedMedia: [{}, {}] })).toBe(
      "[Encrypted 2 media file(s)]"
    );
    expect(getMessagePreview({ text: "hola" })).toBe("hola");
  });
});
