import { describe, expect, it } from "vitest";
import {
  createHistoryOfferRequestSchema,
  HISTORY_OFFER_STATUSES,
  HISTORY_OFFER_TTL_MS,
  historyOfferResponseSchema,
  historyOfferSchema,
  historyOfferStatusSchema,
  listHistoryOffersResponseSchema,
  MAX_SEALED_KEY_BASE64_LENGTH,
  sealedKeySchema,
  type CreateHistoryOfferRequest,
  type HistoryOffer,
} from "../historyOffers";
import { ISO, MANIFEST, OBJECT_ID, OBJECT_ID_2, PUBKEY, SIGNATURE, UUID_V7 } from "./fixtures";

/** HPKE enc (32) || ct (32 + 16 tag) = 80 bytes → 108 base64 chars. */
const SEALED_KEY = Buffer.alloc(80, 5).toString("base64");

const offer: HistoryOffer = {
  id: UUID_V7,
  accountId: OBJECT_ID,
  donorInstanceId: OBJECT_ID_2,
  recipientInstanceId: UUID_V7,
  manifest: MANIFEST,
  sealedKey: SEALED_KEY,
  manifestSignature: SIGNATURE,
  status: "pending",
  createdAt: ISO,
  expiresAt: ISO,
};

const request: CreateHistoryOfferRequest = {
  recipientInstanceId: UUID_V7,
  manifest: MANIFEST,
  sealedKey: SEALED_KEY,
  manifestSignature: SIGNATURE,
};

describe("historyOfferStatusSchema", () => {
  it("is the closed set pending | consumed | expired", () => {
    expect(HISTORY_OFFER_STATUSES).toEqual(["pending", "consumed", "expired"]);
    for (const s of HISTORY_OFFER_STATUSES) expect(historyOfferStatusSchema.safeParse(s).success).toBe(true);
    expect(historyOfferStatusSchema.safeParse("accepted").success).toBe(false);
    expect(HISTORY_OFFER_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });
});

describe("sealedKeySchema", () => {
  it("takes base64 up to 4096 chars", () => {
    expect(MAX_SEALED_KEY_BASE64_LENGTH).toBe(4096);
    expect(sealedKeySchema.safeParse(SEALED_KEY).success).toBe(true);
    expect(sealedKeySchema.safeParse("A".repeat(4096)).success).toBe(true);
    expect(sealedKeySchema.safeParse("A".repeat(4100)).success).toBe(false);
    expect(sealedKeySchema.safeParse("").success).toBe(false);
    expect(sealedKeySchema.safeParse("not base64!").success).toBe(false);
  });
});

describe("historyOfferSchema", () => {
  it("accepts an offer in each status", () => {
    for (const status of HISTORY_OFFER_STATUSES) expect(historyOfferSchema.safeParse({ ...offer, status }).success).toBe(true);
  });
  it("carries either manifest kind: the server hands back what it stored", () => {
    expect(historyOfferSchema.safeParse({ ...offer, manifest: { ...MANIFEST, kind: "backup" } }).success).toBe(true);
  });
  it("rejects a missing field, a bad signature length, a non-manifest and an unknown status", () => {
    const { expiresAt: _omit, ...missing } = offer;
    expect(historyOfferSchema.safeParse(missing).success).toBe(false);
    expect(historyOfferSchema.safeParse({ ...offer, manifestSignature: PUBKEY }).success).toBe(false);
    expect(historyOfferSchema.safeParse({ ...offer, manifest: { v: 1 } }).success).toBe(false);
    expect(historyOfferSchema.safeParse({ ...offer, status: "open" }).success).toBe(false);
    expect(historyOfferSchema.safeParse({ ...offer, sealedKey: "" }).success).toBe(false);
  });
});

describe("createHistoryOfferRequestSchema", () => {
  it("accepts a transfer manifest with a sealed key and a signature", () => {
    expect(createHistoryOfferRequestSchema.safeParse(request).success).toBe(true);
  });
  it("refuses a backup manifest: the kind is inside the signed bytes and must say transfer", () => {
    const r = createHistoryOfferRequestSchema.safeParse({ ...request, manifest: { ...MANIFEST, kind: "backup" } });
    expect(r.success).toBe(false);
    if (!r.success) expect(r.error.issues.map((i) => i.path.join("."))).toContain("manifest.kind");
  });
  it("refuses an unknown kind, a missing recipient, a too-long sealed key and a wrong signature length", () => {
    expect(createHistoryOfferRequestSchema.safeParse({ ...request, manifest: { ...MANIFEST, kind: "export" } }).success).toBe(false);
    const { recipientInstanceId: _omit, ...missing } = request;
    expect(createHistoryOfferRequestSchema.safeParse(missing).success).toBe(false);
    expect(createHistoryOfferRequestSchema.safeParse({ ...request, sealedKey: "A".repeat(4100) }).success).toBe(false);
    expect(createHistoryOfferRequestSchema.safeParse({ ...request, manifestSignature: PUBKEY }).success).toBe(false);
    expect(createHistoryOfferRequestSchema.safeParse({ ...request, manifest: { ...MANIFEST, chunkBlobIds: [] } }).success).toBe(false);
  });
});

describe("responses", () => {
  it("historyOfferResponse wraps one offer; list wraps an array", () => {
    expect(historyOfferResponseSchema.safeParse({ offer }).success).toBe(true);
    expect(historyOfferResponseSchema.safeParse(offer).success).toBe(false);
    expect(historyOfferResponseSchema.safeParse({ offer: null }).success).toBe(false);
    expect(listHistoryOffersResponseSchema.safeParse({ offers: [offer, { ...offer, status: "consumed" }] }).success).toBe(true);
    expect(listHistoryOffersResponseSchema.safeParse({ offers: [] }).success).toBe(true);
    expect(listHistoryOffersResponseSchema.safeParse([offer]).success).toBe(false);
    expect(listHistoryOffersResponseSchema.safeParse({ offers: [{ ...offer, id: "" }] }).success).toBe(false);
  });
});
