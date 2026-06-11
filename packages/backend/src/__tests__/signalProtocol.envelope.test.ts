import { validateEnvelopeMessage } from "../utils/signalProtocol";

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64");
}

const VALID_V2_PAYLOAD = {
  v: 2,
  dh: Buffer.from("dh-public-key-bytes").toString("base64"),
  pn: 0,
  n: 1,
  ct: Buffer.from("nonce-and-aead-ciphertext").toString("base64"),
};

const VALID_CIPHERTEXT = b64(VALID_V2_PAYLOAD);

describe("validateEnvelopeMessage", () => {
  it("accepts a well-formed envelope batch", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [
          { recipientUserId: "b", recipientDeviceId: 1, ciphertext: VALID_CIPHERTEXT },
          { recipientUserId: "b", recipientDeviceId: 2, ciphertext: VALID_CIPHERTEXT },
        ],
        messageType: "text",
      })
    ).toBe(true);
  });

  it("accepts envelopes with valid mediaKeys", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [
          {
            recipientUserId: "b",
            recipientDeviceId: 1,
            ciphertext: VALID_CIPHERTEXT,
            mediaKeys: [{ mediaId: "img1", wrappedKey: "d3JhcA==" }],
          },
        ],
      })
    ).toBe(true);
  });

  it("rejects an empty or missing envelopes array", () => {
    expect(validateEnvelopeMessage({})).toBe(false);
    expect(validateEnvelopeMessage({ envelopes: [] })).toBe(false);
  });

  it("rejects an envelope with an empty recipientUserId", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [{ recipientUserId: "", recipientDeviceId: 1, ciphertext: VALID_CIPHERTEXT }],
      })
    ).toBe(false);
  });

  it("rejects a non-positive or non-integer recipientDeviceId", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [{ recipientUserId: "b", recipientDeviceId: 0, ciphertext: VALID_CIPHERTEXT }],
      })
    ).toBe(false);
    expect(
      validateEnvelopeMessage({
        envelopes: [{ recipientUserId: "b", recipientDeviceId: 1.5, ciphertext: VALID_CIPHERTEXT }],
      })
    ).toBe(false);
  });

  it("rejects an envelope whose ciphertext is not valid v2 wire format", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [
          {
            recipientUserId: "b",
            recipientDeviceId: 1,
            ciphertext: Buffer.from("garbage").toString("base64"),
          },
        ],
      })
    ).toBe(false);
  });

  it("rejects malformed mediaKeys", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [
          {
            recipientUserId: "b",
            recipientDeviceId: 1,
            ciphertext: VALID_CIPHERTEXT,
            mediaKeys: [{ mediaId: "", wrappedKey: "x" }],
          },
        ],
      })
    ).toBe(false);
  });

  it("rejects invalid messageType", () => {
    expect(
      validateEnvelopeMessage({
        envelopes: [{ recipientUserId: "b", recipientDeviceId: 1, ciphertext: VALID_CIPHERTEXT }],
        messageType: "weird",
      })
    ).toBe(false);
  });
});
