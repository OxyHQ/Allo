/**
 * Row → wire shape, for every v1 response.
 *
 * Each projection is built to PARSE with its `@allo/shared-types` schema; the
 * conformance test parses real responses through them. Nullable fields are
 * emitted as `null`, never omitted — `ClientInstance` says so.
 */

import type {
  ClientInstance,
  ConversationEvent,
  ConversationSummary,
  PublicInstance,
} from "@allo/shared-types";
import type { ConversationRow, LeafRow, MemberRow } from "../../db/platform/conversationRepository";
import type { EventReadRow } from "../../db/platform/eventRepository";
import type { InstanceRow } from "../../db/platform/instanceRepository";

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
    status: row.status,
    enrolledAt: isoOrNull(row.enrolledAt),
    revokedAt: isoOrNull(row.revokedAt),
    lastSeenAt: isoOrNull(row.lastSeenAt),
    approvedByInstanceId: row.approvedByInstanceId,
    approvalSignature: row.approvalSignature,
    createdAt: iso(row.createdAt),
  };
}

export function toPublicInstance(row: InstanceRow): PublicInstance {
  return {
    id: row.id,
    accountId: row.accountId,
    appId: row.appId,
    platform: row.platform,
    signingPublicKey: row.signingPublicKey,
    approvedByInstanceId: row.approvedByInstanceId,
    approvalSignature: row.approvalSignature,
    status: row.status,
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
