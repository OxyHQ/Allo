/**
 * Signal Protocol Utilities (backend side).
 *
 * The backend never sees plaintext. Encrypted messages travel as a single
 * base64-encoded JSON object in the `ciphertext` field:
 *
 *   {
 *     v: 2,
 *     dh:  base64,   // Double Ratchet sender DH public key
 *     pn:  number,   // previous chain length
 *     n:   number,   // message number in current chain
 *     ct:  base64,   // nonce || AEAD ciphertext
 *     x3dh?: { ek, ikE, ikD, spk, opk? }  // present only on the first message
 *   }
 *
 * We validate the outer structure to reject obviously malformed payloads but
 * we cannot (and must not) inspect the AEAD body itself.
 */

const WIRE_VERSION = 2;

function safeAtob(s: string): string | null {
  try {
    // Node 16+ has global atob.
    return typeof atob === "function" ? atob(s) : Buffer.from(s, "base64").toString("binary");
  } catch {
    return null;
  }
}

function isBase64String(s: unknown): s is string {
  return typeof s === "string" && s.length > 0 && /^[A-Za-z0-9+/=]+$/.test(s);
}

/**
 * Validate the structure of a wire-format ciphertext blob (without decrypting).
 * Returns true for a well-formed v2 payload; false otherwise.
 */
export function validateWireCiphertext(payload: unknown): boolean {
  if (!isBase64String(payload)) return false;
  const json = safeAtob(payload);
  if (!json) return false;
  try {
    const obj = JSON.parse(json);
    if (!obj || typeof obj !== "object") return false;
    if (obj.v !== WIRE_VERSION) return false;
    if (!isBase64String(obj.dh)) return false;
    if (!isBase64String(obj.ct)) return false;
    if (typeof obj.pn !== "number" || obj.pn < 0) return false;
    if (typeof obj.n !== "number" || obj.n < 0) return false;
    if (obj.x3dh !== undefined) {
      const h = obj.x3dh;
      if (!h || typeof h !== "object") return false;
      if (!isBase64String(h.ek)) return false;
      if (!isBase64String(h.ikE)) return false;
      if (!isBase64String(h.ikD)) return false;
      if (typeof h.spk !== "number") return false;
      if (h.opk !== undefined && typeof h.opk !== "number") return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate Signal Protocol message structure as received by the API.
 * The validator only enforces a few outer-shape invariants; the wire-format
 * payload is validated separately if present.
 */
export function validateEncryptedMessage(message: {
  ciphertext?: string;
  encryptedMedia?: Array<{ ciphertext?: string }>;
  encryptionVersion?: number;
  messageType?: string;
}): boolean {
  const hasCiphertext = typeof message.ciphertext === "string" && message.ciphertext.length > 0;
  const hasMedia = Array.isArray(message.encryptedMedia) && message.encryptedMedia.length > 0;

  if (!hasCiphertext && !hasMedia) return false;

  // Accept both v1 (legacy) and v2 (new ratchet) on the way in. Validation of
  // the inner wire format is enforced only for v2 so legacy messages can still
  // be persisted unchanged for backward compatibility.
  if (message.encryptionVersion !== undefined) {
    if (![1, 2].includes(message.encryptionVersion)) return false;
  }

  if (message.messageType && !["text", "media", "system"].includes(message.messageType)) {
    return false;
  }

  if (hasCiphertext && message.encryptionVersion === WIRE_VERSION) {
    if (!validateWireCiphertext(message.ciphertext)) return false;
  }

  if (hasMedia && message.encryptionVersion === WIRE_VERSION) {
    for (const m of message.encryptedMedia!) {
      if (m && typeof m.ciphertext === "string" && m.ciphertext.length > 0) {
        if (!validateWireCiphertext(m.ciphertext)) return false;
      }
    }
  }

  return true;
}

/**
 * Validate a v3 (per-device envelope) message payload as received by the API.
 *
 * The backend never decrypts; it only enforces structural invariants:
 *  - `envelopes` is a non-empty array,
 *  - every entry has a non-empty `recipientUserId`,
 *  - every entry has a positive-integer `recipientDeviceId`,
 *  - every entry's `ciphertext` passes the v2 wire-format check,
 *  - optional `mediaKeys` entries each have a non-empty `mediaId` + `wrappedKey`.
 */
export function validateEnvelopeMessage(message: {
  envelopes?: Array<{
    recipientUserId?: unknown;
    recipientDeviceId?: unknown;
    ciphertext?: unknown;
    mediaKeys?: Array<{ mediaId?: unknown; wrappedKey?: unknown }>;
  }>;
  messageType?: string;
}): boolean {
  const { envelopes } = message;
  if (!Array.isArray(envelopes) || envelopes.length === 0) return false;

  if (message.messageType && !["text", "media", "system"].includes(message.messageType)) {
    return false;
  }

  for (const env of envelopes) {
    if (!env || typeof env !== "object") return false;
    if (typeof env.recipientUserId !== "string" || env.recipientUserId.length === 0) {
      return false;
    }
    if (
      typeof env.recipientDeviceId !== "number" ||
      !Number.isInteger(env.recipientDeviceId) ||
      env.recipientDeviceId < 1
    ) {
      return false;
    }
    if (!validateWireCiphertext(env.ciphertext)) return false;
    if (env.mediaKeys !== undefined) {
      if (!Array.isArray(env.mediaKeys)) return false;
      for (const mk of env.mediaKeys) {
        if (!mk || typeof mk !== "object") return false;
        if (typeof mk.mediaId !== "string" || mk.mediaId.length === 0) return false;
        if (typeof mk.wrappedKey !== "string" || mk.wrappedKey.length === 0) return false;
      }
    }
  }

  return true;
}

export function isEncrypted(message: {
  ciphertext?: string;
  encryptedMedia?: Array<unknown>;
  text?: string;
  media?: Array<unknown>;
}): boolean {
  return !!(message.ciphertext || (message.encryptedMedia && message.encryptedMedia.length > 0));
}

export function getMessagePreview(message: {
  ciphertext?: string;
  encryptedMedia?: Array<unknown>;
  text?: string;
  media?: Array<unknown>;
}): string {
  if (isEncrypted(message)) {
    if (message.encryptedMedia && message.encryptedMedia.length > 0) {
      return `[Encrypted ${message.encryptedMedia.length} media file(s)]`;
    }
    return "[Encrypted message]";
  }

  if (message.text) return message.text;
  if (message.media && message.media.length > 0) {
    return `Sent ${message.media.length} media file(s)`;
  }

  return "";
}
