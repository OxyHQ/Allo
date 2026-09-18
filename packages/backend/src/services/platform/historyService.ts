/**
 * History offers (`docs/platform/api-v1.md`, History): a donor instance hands
 * another instance of the SAME account its E2EE archive.
 *
 * The rules, in the order they are checked on create:
 *
 *  1. the recipient exists and belongs to the donor's account — otherwise
 *     `not_found`, the same answer for "no such instance" and "somebody
 *     else's", so an offer cannot be used to probe another account's ids;
 *  2. the recipient is not the donor (`validation_failed`), is `active`
 *     (`instance_not_active` / `instance_revoked`) and has a transfer key
 *     (`transfer_key_missing`) — a sealed key nobody can open is not an offer;
 *  3. every chunk blob exists and was uploaded by the donor's account
 *     (`not_found` otherwise, for the same non-probing reason), with no
 *     duplicates (`validation_failed`);
 *  4. `manifestSignature` verifies against the DONOR's signing key over
 *     `archiveManifestMessage(manifest)` (`unauthorized` otherwise). The kind
 *     is inside the signed bytes, and the schema already refused anything but
 *     `transfer`, so a backup manifest cannot be replayed as an offer.
 *
 * Then, in one transaction: insert the offer, mark any older pending offer
 * from this donor to this recipient `expired` and release ITS chunks (the new
 * offer being already inserted, a chunk both name stays), retain the new
 * chunks. After commit, `history.offer` goes to `instance:<recipient>`.
 *
 * The server verifies the signature so a garbage offer never reaches an
 * inbox; the recipient verifies it AGAIN, against the donor's enrollment
 * chain, because the server's word is exactly what the chain makes unnecessary.
 */

import {
  archiveManifestMessage,
  type CreateHistoryOfferRequest,
  type HistoryOffer,
} from "@allo/shared-types";
import { getDb, type AlloDatabase } from "../../db";
import {
  consumeHistoryOffer,
  expireDueOffers,
  expireReplacedOffers,
  findChunkBlobOwners,
  findHistoryOfferById,
  insertHistoryOffer,
  listPendingOffersForRecipient,
  retainChunkBlobs,
} from "../../db/platform/historyRepository";
import { findInstanceById, type InstanceRow } from "../../db/platform/instanceRepository";
import { verifyEd25519 } from "../../middleware/instanceAuth";
import { getRealtime } from "../../runtime/realtime";
import { AlloHttpError, notFound, unauthorized, validationFailed } from "../../utils/httpErrors";
import { toHistoryOffer } from "./wire";

export interface HistoryServiceDeps {
  db?: AlloDatabase;
  now?: () => Date;
}

/** The caller, as `requireInstance` established it. */
export interface Caller {
  id: string;
  accountId: string;
}

/**
 * Every chunk blob exists, belongs to `accountId`, and no id repeats.
 * Shared by offers and backups: both name chunks the same way.
 */
export async function requireOwnChunkBlobs(accountId: string, chunkBlobIds: readonly string[], db: AlloDatabase): Promise<void> {
  if (new Set(chunkBlobIds).size !== chunkBlobIds.length) {
    throw validationFailed("manifest.chunkBlobIds names the same blob twice");
  }
  const owners = await findChunkBlobOwners(chunkBlobIds, db);
  const owned = new Set(owners.filter((blob) => blob.uploaderAccountId === accountId).map((blob) => blob.id));
  const missing = chunkBlobIds.filter((id) => !owned.has(id));
  if (missing.length > 0) throw new AlloHttpError("not_found", "A chunk blob was not found", { chunkBlobIds: missing });
}

/** The manifest signature verifies against `signer`'s key, or `unauthorized`. */
export function requireManifestSignature(
  manifest: CreateHistoryOfferRequest["manifest"],
  signature: string,
  signer: Pick<InstanceRow, "signingPublicKey">,
): void {
  if (!verifyEd25519(archiveManifestMessage(manifest), signature, signer.signingPublicKey)) {
    throw unauthorized("The manifest signature does not verify against the signing instance's key");
  }
}

export async function createHistoryOffer(
  donor: Caller,
  request: CreateHistoryOfferRequest,
  deps: HistoryServiceDeps = {},
): Promise<HistoryOffer> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();

  const donorRow = await findInstanceById(donor.id, db);
  if (!donorRow || donorRow.status !== "active") throw new AlloHttpError("instance_not_active", "Only an active instance may offer history");

  const recipient = await findInstanceById(request.recipientInstanceId, db);
  if (!recipient || recipient.accountId !== donor.accountId) throw notFound("Recipient instance not found");
  if (recipient.id === donor.id) throw validationFailed("An instance cannot offer history to itself");
  if (recipient.status === "revoked") throw new AlloHttpError("instance_revoked", "The recipient instance was revoked");
  if (recipient.status !== "active") throw new AlloHttpError("instance_not_active", "The recipient instance is awaiting approval");
  if (recipient.transferPublicKey === null) {
    throw new AlloHttpError("transfer_key_missing", "The recipient instance has not published a transfer key");
  }

  await requireOwnChunkBlobs(donor.accountId, request.manifest.chunkBlobIds, db);
  requireManifestSignature(request.manifest, request.manifestSignature, donorRow);

  const row = await db.transaction(async (tx) => {
    const inserted = await insertHistoryOffer(
      {
        accountId: donor.accountId,
        donorInstanceId: donor.id,
        recipientInstanceId: recipient.id,
        manifest: request.manifest,
        sealedKey: request.sealedKey,
        manifestSignature: request.manifestSignature,
        now,
      },
      tx,
    );
    await expireReplacedOffers(donor.id, recipient.id, inserted.id, tx);
    await retainChunkBlobs(request.manifest.chunkBlobIds, tx);
    return inserted;
  });

  getRealtime().historyOffer(recipient.id, { offerId: row.id });
  return toHistoryOffer(row);
}

/**
 * The caller's pending offers. A pending offer past its deadline is marked
 * `expired` and its chunks released FIRST, so what is returned is what can
 * still be consumed, and an inbox nobody reads still releases on the sweep.
 */
export async function listPendingHistoryOffers(recipient: Caller, deps: HistoryServiceDeps = {}): Promise<HistoryOffer[]> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  await db.transaction((tx) => expireDueOffers(now, recipient.id, tx));
  const rows = await listPendingOffersForRecipient(recipient.id, db);
  return rows.map(toHistoryOffer);
}

/**
 * The recipient says it has the archive: `pending` → `consumed`, chunks dated
 * a day out. Only the recipient may consume (`not_found` for anybody else,
 * including the donor); an offer that is not pending — consumed already, or
 * past its deadline — is `idempotency_conflict`.
 */
export async function consumeOffer(recipient: Caller, offerId: string, deps: HistoryServiceDeps = {}): Promise<HistoryOffer> {
  const db = deps.db ?? getDb();
  const now = (deps.now ?? (() => new Date()))();
  const offer = await findHistoryOfferById(offerId, db);
  if (!offer || offer.recipientInstanceId !== recipient.id) throw notFound("History offer not found");
  const row = await db.transaction(async (tx) => {
    if (offer.expiresAt.getTime() <= now.getTime()) {
      await expireDueOffers(now, recipient.id, tx);
      return null;
    }
    return consumeHistoryOffer(offer.id, now, tx);
  });
  if (!row) throw new AlloHttpError("idempotency_conflict", "The offer is not pending");
  return toHistoryOffer(row);
}
