import type { Network } from "@allo/shared-types";
import BridgeSession, {
  type BridgeSessionStatus,
  type ExternalSelf,
  type IBridgeSession,
} from "./models/BridgeSession";
import { encryptSession, decryptSession } from "./crypto";
import { logger } from "./logger";

/**
 * Repository over `BridgeSession` that owns the encrypt/decrypt boundary, so no
 * other module ever touches a plaintext session string near persistence. The
 * Telegram manager asks for a decrypted session string to (re)connect, and hands
 * back a fresh string to persist on login — encryption happens here, invisibly.
 */

/** Network this connector serves. The seam is multi-network; this build is Telegram. */
const TELEGRAM: Network = "telegram";

/** A decrypted, ready-to-use view of a stored session. */
export interface LoadedSession {
  ownerUserId: string;
  status: BridgeSessionStatus;
  /** Decrypted Telegram StringSession, or undefined if none stored yet. */
  sessionString?: string;
  externalSelf?: ExternalSelf;
}

/** Read the raw (still-encrypted) session document for an owner. */
export async function getRaw(ownerUserId: string): Promise<IBridgeSession | null> {
  return BridgeSession.findOne({ ownerUserId, network: TELEGRAM });
}

/**
 * Load and DECRYPT a stored session for an owner. Returns null when none exists.
 * If decryption fails (tampering / rotated key), the session is marked `error`
 * and null is returned for the session string so the caller forces a re-login.
 */
export async function load(ownerUserId: string): Promise<LoadedSession | null> {
  const doc = await getRaw(ownerUserId);
  if (!doc) return null;

  let sessionString: string | undefined;
  if (doc.encryptedSession) {
    try {
      sessionString = decryptSession(doc.encryptedSession);
    } catch (error) {
      logger.error(
        `Failed to decrypt stored session for owner ${ownerUserId}; marking session error`,
        error
      );
      doc.status = "error";
      await doc.save();
      sessionString = undefined;
    }
  }

  return {
    ownerUserId: doc.ownerUserId,
    status: doc.status,
    sessionString,
    externalSelf: doc.externalSelf,
  };
}

/** Return the stored status for an owner, or null when not linked. */
export async function getStatus(ownerUserId: string): Promise<BridgeSessionStatus | null> {
  const doc = await getRaw(ownerUserId);
  return doc ? doc.status : null;
}

/** Mark a (possibly not-yet-existing) session as pending a login. */
export async function markPending(ownerUserId: string): Promise<void> {
  await BridgeSession.findOneAndUpdate(
    { ownerUserId, network: TELEGRAM },
    { $set: { status: "pending_login" }, $setOnInsert: { ownerUserId, network: TELEGRAM } },
    { upsert: true }
  );
}

/**
 * Persist a freshly-obtained session string (ENCRYPTED) and mark it active,
 * recording the connected account's own identity. Called on successful login.
 */
export async function saveActive(
  ownerUserId: string,
  sessionString: string,
  externalSelf: ExternalSelf
): Promise<void> {
  const encryptedSession = encryptSession(sessionString);
  await BridgeSession.findOneAndUpdate(
    { ownerUserId, network: TELEGRAM },
    {
      $set: {
        status: "active",
        encryptedSession,
        externalSelf,
      },
      $setOnInsert: { ownerUserId, network: TELEGRAM },
    },
    { upsert: true }
  );
}

/** Update only the status of a stored session (e.g. expired / error / revoked). */
export async function setStatus(
  ownerUserId: string,
  status: BridgeSessionStatus
): Promise<void> {
  await BridgeSession.findOneAndUpdate(
    { ownerUserId, network: TELEGRAM },
    { $set: { status } }
  );
}

/**
 * Revoke and PURGE a stored session: clears the encrypted credential and marks
 * it revoked (called after logging out at Telegram). The encrypted blob is
 * removed so a revoked record carries no usable credential.
 */
export async function revoke(ownerUserId: string): Promise<void> {
  await BridgeSession.findOneAndUpdate(
    { ownerUserId, network: TELEGRAM },
    { $set: { status: "revoked" }, $unset: { encryptedSession: "" } }
  );
}
