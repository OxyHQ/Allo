/**
 * History offers: one instance of an account (the donor) hands another
 * instance of the SAME account (the recipient) its archive. The server holds
 * the manifest, the sealed key and the signature, and relays them; it can
 * open none of it. Live MLS group state is never part of this — a new
 * instance is a new leaf, and this is how its timeline catches up.
 *
 * The recipient trusts nothing the server says about the donor: it verifies
 * the donor's enrollment chain, checks `manifestSignature` against the
 * donor's signing key, opens `sealedKey` with its own transfer key, and only
 * then downloads a chunk.
 */
import { z } from "zod";
import { archiveManifestSchema } from "./archive";
import { accountIdSchema, base64Schema, ed25519SignatureSchema, idSchema, instanceIdSchema, isoDateSchema } from "./common";

export const HISTORY_OFFER_STATUSES = ["pending", "consumed", "expired"] as const;
export const historyOfferStatusSchema = z.enum(HISTORY_OFFER_STATUSES);
export type HistoryOfferStatus = z.infer<typeof historyOfferStatusSchema>;

/** An offer lives this long unconsumed. */
export const HISTORY_OFFER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * HPKE base mode, X25519-HKDF-SHA256 / AES-128-GCM: `enc || ct` over the
 * 32-byte archive key, info {@link HISTORY_KEY_SEAL_INFO}. 32 + 32 + 16 = 80
 * bytes → 108 base64 chars; the bound leaves room for another suite.
 */
export const MAX_SEALED_KEY_BASE64_LENGTH = 4096;
export const sealedKeySchema = base64Schema(MAX_SEALED_KEY_BASE64_LENGTH);

export const historyOfferSchema = z.object({
  id: idSchema,
  accountId: accountIdSchema,
  donorInstanceId: instanceIdSchema,
  recipientInstanceId: instanceIdSchema,
  manifest: archiveManifestSchema,
  sealedKey: sealedKeySchema,
  manifestSignature: ed25519SignatureSchema,
  status: historyOfferStatusSchema,
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
});
export type HistoryOffer = z.infer<typeof historyOfferSchema>;

/**
 * `POST /v1/instances/:id/history-offers` — `:id` is the recipient. The
 * manifest is a `transfer` manifest: a backup manifest signed for a backup
 * must not be replayable as an offer, and the kind is inside the signed bytes.
 */
export const createHistoryOfferRequestSchema = z
  .object({
    recipientInstanceId: instanceIdSchema,
    manifest: archiveManifestSchema,
    sealedKey: sealedKeySchema,
    manifestSignature: ed25519SignatureSchema,
  })
  .superRefine((v, ctx) => {
    if (v.manifest.kind !== "transfer") {
      ctx.addIssue({ code: "custom", path: ["manifest", "kind"], message: "a history offer carries a transfer manifest" });
    }
  });
export type CreateHistoryOfferRequest = z.infer<typeof createHistoryOfferRequestSchema>;

/** `POST …/history-offers`, `POST /v1/instances/me/history-offers/:id/consume` — the one offer, after. */
export const historyOfferResponseSchema = z.object({
  offer: historyOfferSchema,
});
export type HistoryOfferResponse = z.infer<typeof historyOfferResponseSchema>;

/** `GET /v1/instances/me/history-offers` — the caller's pending offers. */
export const listHistoryOffersResponseSchema = z.object({
  offers: z.array(historyOfferSchema),
});
export type ListHistoryOffersResponse = z.infer<typeof listHistoryOffersResponseSchema>;
