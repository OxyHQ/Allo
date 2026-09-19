/**
 * STATUS UPDATES — one ciphertext, a key sealed per device, 24 hours.
 *
 * A status goes to an AUDIENCE, which is not a group, and the difference is
 * the whole design. RFC 9420 gives every member of an MLS group the full
 * ratchet tree, so "my contacts except Ana" built as a group would publish the
 * audience — and Ana's absence from it — to everybody in it. Sender keys avoid
 * that by publishing nothing, which is what WhatsApp and Signal both do.
 *
 * So the poster encrypts the update ONCE under a random per-status key, and
 * seals that key to each recipient INSTANCE with HPKE against the transfer key
 * that instance already publishes (`crypto.md` §12). One body, `N` sealed
 * copies of 32 bytes. The server stores the ciphertext and the sealed keys and
 * can open neither.
 *
 * **The server learns the audience.** It has to: it delivers to the devices in
 * it. WhatsApp's server and Signal's both learn the same thing, and
 * `threat-model.md` §5 says so rather than implying otherwise.
 *
 * **Expiry is a deadline, not a delete.** The row and the blobs go at
 * `expiresAt`, and a client drops what it has decrypted at the same moment —
 * but a status already on somebody's device is theirs, and the screens say
 * that instead of implying the server can reach into a phone.
 */
import { z } from "zod";
import {
  accountIdSchema,
  base64Schema,
  blobIdSchema,
  ed25519SignatureSchema,
  idSchema,
  idempotencyKeySchema,
  instanceIdSchema,
  isoDateSchema,
  sha256HexSchema,
} from "./common";

/** How long a status lives. Not configurable: an audience that cannot predict it cannot consent to it. */
export const STATUS_LIFETIME_MS = 24 * 60 * 60 * 1000;
/** The ciphertext of the status envelope, base64. The media itself is a blob named inside it. */
export const MAX_STATUS_PAYLOAD_BYTES = 8 * 1024;
/** Devices one status may be sealed to. A thousand is a large audience's worth of devices, not an address book. */
export const MAX_STATUS_RECIPIENTS = 1000;
/** Blobs one status may name: a picture and its thumbnail, or a video and its cover. */
export const MAX_STATUS_BLOBS = 4;
/** What one inbox read returns. */
export const MAX_STATUS_PAGE = 200;

/**
 * The HPKE domain separator for a status key.
 *
 * Distinct from `HISTORY_KEY_SEAL_INFO` on purpose: the transfer key's
 * documented purpose widens here from "receives an archive key" to "receives
 * a key sealed to this device", and the two uses stay cryptographically
 * separate because their `info` strings do.
 */
export const STATUS_KEY_SEAL_INFO = "allo-status-key-v1";

/** The 32-byte per-status key, HPKE-sealed to one instance's transfer key. */
export const sealedStatusKeySchema = base64Schema(512);

/**
 * Who a status is sealed to, one device at a time.
 *
 * The client resolves the audience — it knows who it talks to; the server is
 * never asked for a contact list. The server checks only that it is allowed to
 * deliver to each of them: an active instance, of an account that shares a
 * conversation with the author, with no block in either direction.
 */
export const statusRecipientSchema = z.object({
  instanceId: instanceIdSchema,
  sealedKey: sealedStatusKeySchema,
});
export type StatusRecipient = z.infer<typeof statusRecipientSchema>;

/**
 * `POST /v1/statuses`.
 *
 * `payload` is the whole update encrypted under the per-status key: what kind
 * it is, its words, and the key and digest of any media blob. Nothing about it
 * is a field here, because a field here is a field the server reads.
 */
export const createStatusRequestSchema = z.object({
  /**
   * The client's own id for it, so the SIGNATURE can cover it. A server that
   * assigned the id would be signing nothing the author had seen, and could
   * replay an old body under a new id; ids are application-supplied
   * everywhere else in this schema for related reasons (`CONVENTIONS.md`).
   */
  id: idSchema,
  idempotencyKey: idempotencyKeySchema,
  /** AES-256-GCM ciphertext of the status envelope. */
  payload: base64Schema(MAX_STATUS_PAYLOAD_BYTES),
  nonce: base64Schema(64),
  /** Of the ciphertext, so a recipient verifies before it decrypts. */
  sha256: sha256HexSchema,
  /** Blobs this status names, so they are retained for as long as it lives. */
  blobIds: z.array(blobIdSchema).max(MAX_STATUS_BLOBS).default([]),
  recipients: z.array(statusRecipientSchema).min(1).max(MAX_STATUS_RECIPIENTS),
  /**
   * The author instance over `statusSignatureMessage`. A recipient verifies it
   * against the published instance key before decrypting, so a status the
   * server made up is refused on the device rather than trusted.
   */
  /**
   * When it dies. The client computes it and signs it; the server refuses
   * anything past `STATUS_LIFETIME_MS` from now, so a signed deadline cannot
   * be a year and an unsigned one cannot be forged.
   */
  expiresAt: isoDateSchema,
  signature: ed25519SignatureSchema,
});
export type CreateStatusRequest = z.infer<typeof createStatusRequestSchema>;

/** What the author's instance signs. The digest covers the ciphertext, so the words are outside the server's reach and inside the signature. */
export function statusSignatureMessage(input: {
  statusId: string;
  authorAccountId: string;
  sha256: string;
  expiresAt: string;
}): string {
  return ["allo-status-v1", input.statusId, input.authorAccountId, input.sha256, input.expiresAt].join("\n");
}

/** One status as a recipient receives it: the body, the key sealed to THIS instance, and who wrote it. */
export const statusSchema = z.object({
  id: idSchema,
  authorAccountId: accountIdSchema,
  authorInstanceId: instanceIdSchema,
  payload: base64Schema(MAX_STATUS_PAYLOAD_BYTES),
  nonce: base64Schema(64),
  sha256: sha256HexSchema,
  blobIds: z.array(blobIdSchema).max(MAX_STATUS_BLOBS),
  /** Absent in the author's own listing of what they posted: they hold the key already. */
  sealedKey: sealedStatusKeySchema.nullable(),
  signature: ed25519SignatureSchema,
  createdAt: isoDateSchema,
  expiresAt: isoDateSchema,
});
export type Status = z.infer<typeof statusSchema>;

export const createStatusResponseSchema = z.object({
  status: statusSchema,
  /**
   * Recipients the server refused to deliver to — blocked, gone, or sharing no
   * conversation with the author. Named so the app can be honest about who did
   * not get it rather than implying everybody did.
   */
  refused: z.array(instanceIdSchema),
});
export type CreateStatusResponse = z.infer<typeof createStatusResponseSchema>;

export const listStatusesResponseSchema = z.object({
  statuses: z.array(statusSchema),
});
export type ListStatusesResponse = z.infer<typeof listStatusesResponseSchema>;

/**
 * Who has seen a status, as its author sees it.
 *
 * A viewer who has turned status receipts off is not in this list, and the
 * author is not told that somebody is missing: the same indistinguishability
 * presence has, for the same reason.
 */
export const statusViewSchema = z.object({
  accountId: accountIdSchema,
  viewedAt: isoDateSchema,
});
export type StatusView = z.infer<typeof statusViewSchema>;

export const listStatusViewsResponseSchema = z.object({
  views: z.array(statusViewSchema),
  /** How many accounts have seen it, including those that publish no receipt. */
  total: z.number().int().nonnegative(),
});
export type ListStatusViewsResponse = z.infer<typeof listStatusViewsResponseSchema>;

/**
 * THE PLAINTEXT INSIDE, which the server never sees.
 *
 * Versioned by clients alone, exactly as `AppMessage` is: a receiver that
 * meets a `v` it does not know shows nothing rather than guessing. The media
 * is a blob named here with its own key, the way a `media` message names one,
 * so the bytes are encrypted once and fetched on demand.
 */
export const STATUS_PAYLOAD_VERSION = 1;
export const MAX_STATUS_CAPTION_LENGTH = 700;

export const statusMediaSchema = z.object({
  blobId: blobIdSchema,
  /** The 32-byte AES-256 content key for the blob, base64. */
  key: base64Schema(64),
  nonce: base64Schema(64),
  /** Of the CIPHERTEXT as uploaded. */
  sha256: sha256HexSchema,
  mime: z.string().min(1).max(255),
  size: z.number().int().nonnegative(),
  width: z.number().int().nonnegative().optional(),
  height: z.number().int().nonnegative().optional(),
  durationMs: z.number().int().nonnegative().optional(),
});
export type StatusMedia = z.infer<typeof statusMediaSchema>;

export const statusPayloadSchema = z.object({
  v: z.literal(STATUS_PAYLOAD_VERSION),
  kind: z.enum(["text", "image", "video"]),
  /** The words, if there are any. A text status is only words. */
  caption: z.string().min(1).max(MAX_STATUS_CAPTION_LENGTH).optional(),
  media: statusMediaSchema.optional(),
});
export type StatusPayload = z.infer<typeof statusPayloadSchema>;

/** Server → client: somebody this instance can decrypt posted something. */
export const statusPostedEventSchema = z.object({
  statusId: idSchema,
  authorAccountId: accountIdSchema,
});
export type StatusPostedEvent = z.infer<typeof statusPostedEventSchema>;
