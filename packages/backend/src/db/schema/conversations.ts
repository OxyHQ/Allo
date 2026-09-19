/**
 * Conversations, their members (accounts), their leaves (instances in the
 * MLS group) and the stored GroupInfo a leafless member joins from.
 *
 * The server knows WHO is in a conversation and WHICH installations hold a
 * leaf; it never knows the conversation's name or any message — those are
 * MLS application messages (`docs/platform/api-v1.md`).
 */

import { sql } from "drizzle-orm";
import { bigint, check, index, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { bytea, createdAt, timestamptz, updatedAt } from "@oxy.so/db";
import { CONVERSATION_KINDS, LEAF_STATES, MEMBER_ROLES, MEMBER_STATES } from "@allo/shared-types";
import { checkOneOf } from "./columns";
import { clientInstances } from "./instances";

export type ConversationKind = (typeof CONVERSATION_KINDS)[number];
export type MemberRole = (typeof MEMBER_ROLES)[number];
export type MemberState = (typeof MEMBER_STATES)[number];
export type LeafState = (typeof LEAF_STATES)[number];

/**
 * `dm_key` is `dmKeyFor(appId, a, b)` from `@allo/shared-types` and unique, so
 * two clients creating the same DM at once converge on one row: the loser's
 * insert is a unique violation the route turns into `created: false`. The
 * CHECK makes the key mandatory for a `dm`, because a DM without one is a DM
 * that can be created twice.
 *
 * `mls_group_id` is chosen by the creator and unique server-wide.
 *
 * `current_epoch` and `last_seq` are advanced under `SELECT … FOR UPDATE` on
 * this row (`db/platform/eventRepository.ts`), which is the serialisation
 * point for the whole event log of one conversation. `bigint` because both are
 * unbounded counters; drizzle hands them back as `number` (`mode: "number"`),
 * which is safe up to 2^53 and is what the wire contract carries.
 */
export const conversations = pgTable(
  "conversations",
  {
    id: text().primaryKey(),
    kind: text({ enum: CONVERSATION_KINDS }).notNull(),
    appId: text().notNull(),
    dmKey: text().unique("conversations_dm_key_key"),
    mlsGroupId: text().notNull().unique("conversations_mls_group_id_key"),
    currentEpoch: bigint({ mode: "number" }).notNull().default(0),
    lastSeq: bigint({ mode: "number" }).notNull().default(0),
    createdByAccountId: text().notNull(),
    createdByInstanceId: text().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    checkOneOf("conversations_kind_check", t.kind, CONVERSATION_KINDS),
    check("conversations_dm_key_check", sql`${t.kind} <> 'dm' or ${t.dmKey} is not null`),
    check("conversations_current_epoch_check", sql`${t.currentEpoch} >= 0`),
    check("conversations_last_seq_check", sql`${t.lastSeq} >= 0`),
  ],
);

/**
 * One row per (conversation, account). `state` is the account's membership;
 * which of its installations are in the MLS group is `conversation_leaves`.
 *
 * A member is `removed` when another account's commit took its last active
 * leaf away, and `left` when it left itself (`POST …/leave` or a self-remove
 * commit). Both keep the row: membership history is what says who could ever
 * have read what.
 */
export const conversationMembers = pgTable(
  "conversation_members",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    role: text({ enum: MEMBER_ROLES }).notNull().default("member"),
    state: text({ enum: MEMBER_STATES }).notNull().default("joined"),
    joinedAt: timestamptz().notNull().defaultNow(),
    leftAt: timestamptz(),
    addedByAccountId: text(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_members_conversation_id_account_id_key").on(
      t.conversationId,
      t.accountId,
    ),
    index("conversation_members_account_id_state_idx").on(t.accountId, t.state),
    checkOneOf("conversation_members_role_check", t.role, MEMBER_ROLES),
    checkOneOf("conversation_members_state_check", t.state, MEMBER_STATES),
  ],
);

/**
 * Which instances are in the MLS group, and since which epoch.
 *
 * `added_epoch` is the epoch the leaf became part of the group (the epoch the
 * adding commit CREATED). `removed_epoch` is the epoch the removing commit
 * created; it stays NULL on a leaf that is `removed` because its instance was
 * revoked server-side and no client has committed the Remove yet — that is the
 * only case in which `state = 'removed'` and `removed_epoch IS NULL` coexist,
 * and the commit rules in `eventRepository.ts` accept such a leaf in
 * `removedLeaves`.
 */
export const conversationLeaves = pgTable(
  "conversation_leaves",
  {
    id: text().primaryKey(),
    conversationId: text()
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    instanceId: text()
      .notNull()
      .references(() => clientInstances.id, { onDelete: "cascade" }),
    accountId: text().notNull(),
    state: text({ enum: LEAF_STATES }).notNull(),
    addedEpoch: bigint({ mode: "number" }).notNull(),
    removedEpoch: bigint({ mode: "number" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("conversation_leaves_conversation_id_instance_id_key").on(
      t.conversationId,
      t.instanceId,
    ),
    index("conversation_leaves_instance_id_state_idx").on(t.instanceId, t.state),
    checkOneOf("conversation_leaves_state_check", t.state, LEAF_STATES),
    check("conversation_leaves_added_epoch_check", sql`${t.addedEpoch} >= 0`),
  ],
);

/**
 * The stored `GroupInfo` of a conversation: what a device that is a member
 * with no active leaf joins from, by MLS external commit, with nobody else
 * online (`docs/platform/crypto.md`, external join).
 *
 * One row per conversation, for the CURRENT epoch only. Every accepted
 * `mls_commit` replaces it in the same transaction (`CommitInfo.groupInfo`,
 * `eventRepository.ts`), and a member holding an active leaf may re-publish it
 * for the current epoch (`PUT …/group-info`) so a conversation whose last
 * commit predates the field becomes joinable. `epoch` is therefore expected
 * to equal `conversations.current_epoch`; a reader that finds otherwise
 * serves `null`, never a stale one.
 *
 * `data` is opaque public MLS material (`external_pub` plus the ratchet tree,
 * ≤ 256 KiB) that the server never parses. It is registered in
 * `protectedColumns.ts`: whoever holds it can attempt an external join, so it
 * reaches exactly the readers that gate on membership and nothing else.
 *
 * `signer_instance_id` is the instance whose commit or re-publish produced it,
 * kept for the joiner's benefit and for forensics; it is NOT a foreign key,
 * because deleting that instance must not delete the only thing a later device
 * can join from.
 */
export const conversationGroupInfo = pgTable(
  "conversation_group_info",
  {
    conversationId: text()
      .primaryKey()
      .references(() => conversations.id, { onDelete: "cascade" }),
    epoch: bigint({ mode: "number" }).notNull(),
    signerInstanceId: text().notNull(),
    data: bytea().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("conversation_group_info_epoch_check", sql`${t.epoch} >= 0`)],
);
