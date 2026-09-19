/**
 * Row → wire shape, for every v1 response.
 *
 * Each projection is built to PARSE with its `@allo/shared-types` schema; the
 * conformance test parses real responses through them. Nullable fields are
 * emitted as `null`, never omitted — `ClientInstance` says so.
 */

import type {
  AccountBackup,
  ClientInstance,
  ConversationEvent,
  ConversationSummary,
  HistoryOffer,
  PublicInstance,
  Status,
} from "@allo/shared-types";
import type { ConversationRow, LeafRow, MemberRow } from "../../db/platform/conversationRepository";
import type { EventReadRow } from "../../db/platform/eventRepository";
import type { AccountBackupRow, HistoryOfferRow } from "../../db/platform/historyRepository";
import type { InstanceRow } from "../../db/platform/instanceRepository";
import type { StatusRow } from "../../db/platform/statusRepository";

const iso = (date: Date): string => date.toISOString();
const isoOrNull = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toClientInstance(row: InstanceRow): ClientInstance {
  return {
    id: row.id,
    accountId: row.accountId,
    appId: row.appId,
    platform: row.platform,
    displayName: row.displayName,
    signingPublicKey: row.signingPublicKey,
    transferPublicKey: row.transferPublicKey,
    status: row.status,
    enrolledAt: isoOrNull(row.enrolledAt),
    revokedAt: isoOrNull(row.revokedAt),
    lastSeenAt: isoOrNull(row.lastSeenAt),
    approvedByInstanceId: row.approvedByInstanceId,
    approvalSignature: row.approvalSignature,
    enrollmentChallenge: publishedChallenge(row),
    createdAt: iso(row.createdAt),
  };
}

/**
 * The challenge is published once it has been SIGNED — after approval, so any
 * client can verify the enrollment chain — and is null for the bootstrap
 * instance and while an enrollment is pending. A pending challenge is returned
 * to the owner only, through `GET /v1/instances/pending` and the registration
 * answer, never through this projection.
 */
export function publishedChallenge(row: Pick<InstanceRow, "status" | "enrollmentChallenge" | "approvalSignature">): string | null {
  if (row.status === "pending" || row.approvalSignature === null) return null;
  return row.enrollmentChallenge;
}

export function toPublicInstance(row: InstanceRow): PublicInstance {
  return {
    id: row.id,
    accountId: row.accountId,
    appId: row.appId,
    platform: row.platform,
    signingPublicKey: row.signingPublicKey,
    transferPublicKey: row.transferPublicKey,
    approvedByInstanceId: row.approvedByInstanceId,
    approvalSignature: row.approvalSignature,
    enrollmentChallenge: publishedChallenge(row),
    status: row.status,
  };
}

/**
 * The offer as the recipient (and the donor, in its `POST` answer) sees it,
 * sealed key included: that is what the row is for. `manifest` is the stored
 * jsonb, which was parsed with `archiveManifestSchema` on the way in.
 */
export function toHistoryOffer(row: HistoryOfferRow): HistoryOffer {
  return {
    id: row.id,
    accountId: row.accountId,
    donorInstanceId: row.donorInstanceId,
    recipientInstanceId: row.recipientInstanceId,
    manifest: row.manifest,
    sealedKey: row.sealedKey,
    manifestSignature: row.manifestSignature,
    status: row.status,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function toAccountBackup(row: AccountBackupRow): AccountBackup {
  return {
    accountId: row.accountId,
    instanceId: row.instanceId,
    manifest: row.manifest,
    keyCheck: row.keyCheck,
    manifestSignature: row.manifestSignature,
    updatedAt: iso(row.updatedAt),
  };
}

/**
 * A status as ONE device receives it: the ciphertext, and the key sealed to
 * that device. `sealedKey` is `null` for the author's own listing, which is
 * the one case where the reader already holds the key — and `null` rather than
 * omitted, as everywhere else here.
 */
export function toStatus(row: StatusRow, sealedKey: string | null): Status {
  return {
    id: row.id,
    authorAccountId: row.authorAccountId,
    authorInstanceId: row.authorInstanceId,
    payload: row.payload.toString("base64"),
    nonce: row.nonce.toString("base64"),
    sha256: row.sha256,
    blobIds: row.blobIds,
    sealedKey,
    signature: row.signature,
    createdAt: iso(row.createdAt),
    expiresAt: iso(row.expiresAt),
  };
}

export function toConversationEvent(row: EventReadRow): ConversationEvent {
  return {
    id: row.id,
    conversationId: row.conversationId,
    seq: row.seq,
    kind: row.kind,
    epoch: row.epoch,
    senderAccountId: row.senderAccountId,
    senderInstanceId: row.senderInstanceId,
    payload: Buffer.from(row.payload).toString("base64"),
    blobIds: row.blobIds,
    createdAt: iso(row.createdAt),
  };
}

export function toConversationSummary(
  conversation: ConversationRow,
  members: readonly MemberRow[],
  leaves: readonly LeafRow[],
  viewerInstanceId: string,
): ConversationSummary {
  const mine = leaves.find((leaf) => leaf.instanceId === viewerInstanceId);
  return {
    id: conversation.id,
    kind: conversation.kind,
    appId: conversation.appId,
    mlsGroupId: conversation.mlsGroupId,
    epoch: conversation.currentEpoch,
    lastSeq: conversation.lastSeq,
    members: members.map((member) => ({
      accountId: member.accountId,
      role: member.role,
      state: member.state,
      joinedAt: iso(member.joinedAt),
    })),
    leaves: leaves.map((leaf) => ({
      instanceId: leaf.instanceId,
      accountId: leaf.accountId,
      state: leaf.state,
      addedEpoch: leaf.addedEpoch,
    })),
    myLeafState: mine ? mine.state : null,
    createdByAccountId: conversation.createdByAccountId,
    createdAt: iso(conversation.createdAt),
  };
}
