import { describe, expect, it } from "vitest";
import {
  ALLO_ERROR_CODES,
  alloErrorCodeSchema,
  appIdSchema,
  base64Schema,
  base64UrlDecode,
  base64UrlEncode,
  base64UrlSchema,
  ed25519PublicKeySchema,
  ed25519SignatureSchema,
  x25519PublicKeySchema,
  EMPTY_BODY_SHA256_HEX,
  epochConflictDetailsSchema,
  errorResponseSchema,
  idSchema,
  isoDateSchema,
  nonNegativeIntSchema,
  platformSchema,
  sha256HexSchema,
} from "../common";
import { B64, BLOB_HEX_ID, CHALLENGE, ISO, OBJECT_ID, PUBKEY, SIGNATURE, UUID_V7 } from "./fixtures";

describe("base64Schema", () => {
  it("accepts padded standard base64", () => {
    expect(base64Schema().safeParse(B64).success).toBe(true);
    expect(base64Schema(B64.length).safeParse(B64).success).toBe(true);
  });
  it("rejects empty, over-long, url-alphabet and unpadded input", () => {
    expect(base64Schema().safeParse("").success).toBe(false);
    expect(base64Schema(B64.length - 1).safeParse(B64).success).toBe(false);
    expect(base64Schema().safeParse("a-b_").success).toBe(false);
    expect(base64Schema().safeParse("aGk").success).toBe(false);
    expect(base64Schema().safeParse(42).success).toBe(false);
  });
});

describe("base64UrlSchema", () => {
  it("accepts an unpadded url-safe challenge", () => {
    expect(base64UrlSchema(64).safeParse(CHALLENGE).success).toBe(true);
  });
  it("rejects '+', '/', '=' and emptiness", () => {
    expect(base64UrlSchema().safeParse("a+b").success).toBe(false);
    expect(base64UrlSchema().safeParse("a/b").success).toBe(false);
    expect(base64UrlSchema().safeParse("ab==").success).toBe(false);
    expect(base64UrlSchema().safeParse("").success).toBe(false);
  });
});

describe("idSchema", () => {
  it("accepts a uuid v7, an ObjectId and a 64-hex blob id alike", () => {
    for (const id of [UUID_V7, OBJECT_ID, BLOB_HEX_ID, "abcdefgh"]) {
      expect(idSchema.safeParse(id).success, id).toBe(true);
    }
  });
  it("rejects too short, too long, and foreign characters", () => {
    expect(idSchema.safeParse("abcdefg").success).toBe(false);
    expect(idSchema.safeParse("a".repeat(65)).success).toBe(false);
    expect(idSchema.safeParse("allo:server").success).toBe(false);
    expect(idSchema.safeParse("has space!").success).toBe(false);
  });
});

describe("appIdSchema / platformSchema", () => {
  it("accepts allo, mention, ios", () => {
    expect(appIdSchema.safeParse("allo").success).toBe(true);
    expect(appIdSchema.safeParse("mention-2").success).toBe(true);
    expect(platformSchema.safeParse("ios").success).toBe(true);
  });
  it("rejects uppercase, leading digit, single char, unknown platform", () => {
    expect(appIdSchema.safeParse("Allo").success).toBe(false);
    expect(appIdSchema.safeParse("1allo").success).toBe(false);
    expect(appIdSchema.safeParse("a").success).toBe(false);
    expect(platformSchema.safeParse("tvos").success).toBe(false);
  });
});

describe("isoDateSchema", () => {
  it("accepts toISOString output and an offset", () => {
    expect(isoDateSchema.safeParse(ISO).success).toBe(true);
    expect(isoDateSchema.safeParse("2026-09-17T10:20:30+02:00").success).toBe(true);
  });
  it("rejects a date-only string and a unix number", () => {
    expect(isoDateSchema.safeParse("2026-09-17").success).toBe(false);
    expect(isoDateSchema.safeParse(1_700_000_000_000).success).toBe(false);
  });
});

describe("key and digest shapes", () => {
  it("pins the Ed25519 key to 44 and the signature to 88 base64 chars", () => {
    expect(ed25519PublicKeySchema.safeParse(PUBKEY).success).toBe(true);
    expect(ed25519SignatureSchema.safeParse(SIGNATURE).success).toBe(true);
    expect(ed25519PublicKeySchema.safeParse(SIGNATURE).success).toBe(false);
    expect(ed25519SignatureSchema.safeParse(PUBKEY).success).toBe(false);
  });
  it("an X25519 public key is 44 base64 chars, like the Ed25519 one", () => {
    expect(x25519PublicKeySchema.safeParse(PUBKEY).success).toBe(true);
    expect(x25519PublicKeySchema.safeParse(SIGNATURE).success).toBe(false);
    expect(x25519PublicKeySchema.safeParse(PUBKEY.slice(0, 43)).success).toBe(false);
    expect(x25519PublicKeySchema.safeParse("not base64!" + PUBKEY.slice(11)).success).toBe(false);
  });
  it("sha256 hex is lowercase and 64 long", () => {
    expect(sha256HexSchema.safeParse(EMPTY_BODY_SHA256_HEX).success).toBe(true);
    expect(sha256HexSchema.safeParse(EMPTY_BODY_SHA256_HEX.toUpperCase()).success).toBe(false);
    expect(sha256HexSchema.safeParse(EMPTY_BODY_SHA256_HEX.slice(1)).success).toBe(false);
  });
  it("EMPTY_BODY_SHA256_HEX is the digest of the empty string", async () => {
    const { createHash } = await import("node:crypto");
    expect(createHash("sha256").update("").digest("hex")).toBe(EMPTY_BODY_SHA256_HEX);
  });
});

describe("nonNegativeIntSchema", () => {
  it("accepts 0 and MAX_SAFE_INTEGER; rejects -1, 1.5 and beyond safe", () => {
    expect(nonNegativeIntSchema.safeParse(0).success).toBe(true);
    expect(nonNegativeIntSchema.safeParse(Number.MAX_SAFE_INTEGER).success).toBe(true);
    expect(nonNegativeIntSchema.safeParse(-1).success).toBe(false);
    expect(nonNegativeIntSchema.safeParse(1.5).success).toBe(false);
    expect(nonNegativeIntSchema.safeParse(Number.MAX_SAFE_INTEGER + 2).success).toBe(false);
  });
});

describe("errorResponseSchema", () => {
  it("accepts the envelope with and without details, and an unknown code", () => {
    expect(errorResponseSchema.safeParse({ error: { code: "not_found", message: "no" } }).success).toBe(true);
    expect(
      errorResponseSchema.safeParse({ error: { code: "epoch_conflict", message: "x", details: { currentEpoch: 3 } } }).success,
    ).toBe(true);
    expect(errorResponseSchema.safeParse({ error: { code: "from_the_future", message: "" } }).success).toBe(true);
  });
  it("rejects the legacy flat { error, message } shape and an empty code", () => {
    expect(errorResponseSchema.safeParse({ error: "not_found", message: "no" }).success).toBe(false);
    expect(errorResponseSchema.safeParse({ error: { code: "", message: "no" } }).success).toBe(false);
  });
  it("the closed set has sixteen codes and epoch_conflict details carry the epoch", () => {
    expect(ALLO_ERROR_CODES).toHaveLength(16);
    expect(alloErrorCodeSchema.safeParse("epoch_conflict").success).toBe(true);
    expect(alloErrorCodeSchema.safeParse("group_info_missing").success).toBe(true);
    expect(alloErrorCodeSchema.safeParse("transfer_key_missing").success).toBe(true);
    expect(alloErrorCodeSchema.safeParse("backup_not_found").success).toBe(true);
    expect(alloErrorCodeSchema.safeParse("teapot").success).toBe(false);
    expect(epochConflictDetailsSchema.safeParse({ currentEpoch: 7 }).success).toBe(true);
    expect(epochConflictDetailsSchema.safeParse({ currentEpoch: "7" }).success).toBe(false);
  });
});

describe("base64url codec", () => {
  it("round-trips every remainder class and matches Node", () => {
    for (const len of [0, 1, 2, 3, 4, 5, 31, 32, 33, 64]) {
      const bytes = new Uint8Array(len).map((_, i) => (i * 37 + 11) & 0xff);
      const encoded = base64UrlEncode(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64url"));
      expect(Array.from(base64UrlDecode(encoded))).toEqual(Array.from(bytes));
    }
  });
  it("uses the url alphabet", () => {
    expect(base64UrlEncode(new Uint8Array([0xfb, 0xff]))).toBe("-_8");
  });
  it("rejects bad characters and impossible lengths", () => {
    expect(() => base64UrlDecode("ab+c")).toThrow(RangeError);
    expect(() => base64UrlDecode("ab=")).toThrow(RangeError);
    expect(() => base64UrlDecode("a")).toThrow(RangeError);
  });
});
