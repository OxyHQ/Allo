/**
 * The typed records the SDK persists. Every one is JSON (bytes as base64)
 * encrypted at rest by the store, except `groupState`, which is the raw
 * ts-mls encoding, also encrypted. The zod schemas are the migration gate:
 * a row that does not parse is a bug, not a silent default.
 */
import { appMessageSchema, conversationEventSchema, submitEventRequestSchema, type AppMessage } from "@allo/shared-types";
import { z } from "zod";

const b64 = z.string();

export const instanceRecordSchema = z.object({
  id: z.string(),
  accountId: z.string(),
  appId: z.string(),
  platform: z.enum(["ios", "android", "web", "desktop", "node"]),
  displayName: z.string(),
  signingPublicKey: b64,
  /** The X25519 transfer key the SERVER holds for this instance; compared with the local one and re-uploaded when they differ. Absent on a Phase 2 record. */
  transferPublicKey: b64.nullable().default(null),
  status: z.enum(["pending", "active", "revoked"]),
  /** The challenge issued at registration; kept so this instance can verify its own approval later. */
  challenge: z.string().nullable(),
  approvedByInstanceId: z.string().nullable(),
  approvalSignature: z.string().nullable(),
  createdAt: z.string(),
});
export type InstanceRecord = z.infer<typeof instanceRecordSchema>;

export const conversationRecordSchema = z.object({
  id: z.string(),
  kind: z.enum(["dm", "group"]),
  appId: z.string(),
  mlsGroupId: b64,
  createdByAccountId: z.string(),
  createdAt: z.string(),
  /** From the E2EE `conversation` message. */
  name: z.string().nullable(),
  members: z.array(z.object({ accountId: z.string(), role: z.enum(["owner", "admin", "member"]), state: z.enum(["joined", "left", "removed"]) })),
  /** Highest server seq seen (delivered, fetched or own). Gap detection compares against it. */
  lastSeq: z.number().int().min(0),
  /** The epoch this leaf joined at; nothing older is decryptable here. */
  joinedEpoch: z.number().int().min(0).nullable(),
  /** Seq of the newest own or others' item this account has read. */
  lastReadSeq: z.number().int().min(0),
  /** Whether this instance ever held a leaf that is now removed. */
  removed: z.boolean(),
  /**
   * Everything at or below this seq was DELETED on this device, by a
   * "delete conversation" here or a `clear_history` from somebody in it.
   *
   * The rows are gone, so this is not a filter over them; what it holds is the
   * line, so a conversation with nothing newer stays out of the list and comes
   * back the moment somebody says something. Absent on records written before
   * the feature existed, which reads as "nothing was ever cleared".
   */
  clearedUpToSeq: z.number().int().min(0).optional(),
  lastActivityAt: z.string(),
  /** The first commit this device refused for admission reasons after the server accepted it (`ConversationView.integrity`). */
  refusedCommit: z.object({ epoch: z.number().int().min(0), reason: z.string() }).nullable().default(null),
});
export type ConversationRecord = z.infer<typeof conversationRecordSchema>;

export const pendingCommitRecordSchema = z.object({
  outboxItemId: z.string(),
  conversationId: z.string(),
  /** The epoch the commit was built at; `next` is at epoch + 1. */
  epoch: z.number().int().min(0),
  nextState: b64,
  /** The exact request sent, so a retry after a crash is byte-identical and the server's replay answer applies. */
  request: submitEventRequestSchema.optional(),
});
export type PendingCommitRecord = z.infer<typeof pendingCommitRecordSchema>;

/** A decrypted (or undecryptable) timeline event. Ciphertext is not kept: MLS keys are consumed on decryption. */
export const eventRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  seq: z.number().int().min(0),
  kind: conversationEventSchema.shape.kind,
  epoch: z.number().int().min(0),
  senderAccountId: z.string(),
  senderInstanceId: z.string().nullable(),
  createdAt: z.string(),
  /** Our own idempotency key when the event is ours. */
  localKey: z.string().nullable(),
  message: appMessageSchema.nullable(),
  /** Set when `message` is null for a reason worth showing. */
  failure: z.string().nullable(),
  /** System text for control events. */
  system: z.string().nullable(),
});
export type EventRecord = z.infer<typeof eventRecordSchema>;

export const outboxCommitIntentSchema = z.object({
  adds: z.array(z.object({ instanceId: z.string(), accountId: z.string(), keyPackage: b64 })),
  /** Instance ids whose leaves to remove. */
  removes: z.array(z.string()),
  /** Why: `add_instances` | `revoked` | `member_left` | `remove_member`. Informational. */
  reason: z.string(),
});
export type OutboxCommitIntent = z.infer<typeof outboxCommitIntentSchema>;

export const outboxItemRecordSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  kind: z.enum(["app_message", "commit"]),
  createdAt: z.string(),
  attempts: z.number().int().min(0),
  state: z.enum(["pending", "failed"]),
  failure: z.string().nullable(),
  message: appMessageSchema.nullable(),
  commit: outboxCommitIntentSchema.nullable(),
  blobIds: z.array(z.string()),
});
export type OutboxItemRecord = z.infer<typeof outboxItemRecordSchema>;

export const cursorRecordSchema = z.object({ cursor: z.string() });
export type CursorRecord = z.infer<typeof cursorRecordSchema>;

export const keyPackageRecordSchema = z.object({
  ref: b64,
  publicWire: b64,
  initPrivateKey: b64,
  hpkePrivateKey: b64,
  signaturePrivateKey: b64,
  createdAt: z.string(),
  uploaded: z.boolean(),
});
export type KeyPackageRecord = z.infer<typeof keyPackageRecordSchema>;

export const mediaKeyRecordSchema = z.object({
  blobId: z.string(),
  conversationId: z.string(),
  key: b64,
  nonce: b64,
  sha256: z.string(),
  mime: z.string(),
  size: z.number().int().min(0),
});
export type MediaKeyRecord = z.infer<typeof mediaKeyRecordSchema>;

/** A delivery that arrived before its epoch (or before this leaf joined); replayed after each commit. */
export const queuedEventRecordSchema = z.object({
  event: conversationEventSchema,
});
export type QueuedEventRecord = z.infer<typeof queuedEventRecordSchema>;

/** An own instance this one (as elector) has offered its history to. One offer per recipient, ever. */
export const historyOfferedRecordSchema = z.object({
  instanceId: z.string(),
  offerId: z.string(),
  offeredAt: z.string(),
});
export type HistoryOfferedRecord = z.infer<typeof historyOfferedRecordSchema>;

/** The backup switch and what the last refresh covered. The key itself is in the secret store. */
export const backupStateRecordSchema = z.object({
  enabled: z.boolean(),
  lastBackupAt: z.string().nullable(),
  /** Stored events at the last refresh; the auto-refresh policy compares against it. */
  eventCountAtBackup: z.number().int().min(0),
});
export type BackupStateRecord = z.infer<typeof backupStateRecordSchema>;

export type { AppMessage };
