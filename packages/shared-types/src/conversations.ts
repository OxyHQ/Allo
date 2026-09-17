/**
 * Conversations: a DM or a group, one MLS group each. The server knows who
 * is in it and which instances hold a leaf; it never knows its name.
 */
import { z } from "zod";
import {
  accountIdSchema,
  appIdSchema,
  base64Schema,
  conversationIdSchema,
  idempotencyKeySchema,
  instanceIdSchema,
  isoDateSchema,
  nonNegativeIntSchema,
} from "./common";
import { submitEventRequestSchema } from "./events";

export const CONVERSATION_KINDS = ["dm", "group"] as const;
export const conversationKindSchema = z.enum(CONVERSATION_KINDS);
export type ConversationKind = z.infer<typeof conversationKindSchema>;

export const MEMBER_ROLES = ["owner", "admin", "member"] as const;
export const memberRoleSchema = z.enum(MEMBER_ROLES);
export type MemberRole = z.infer<typeof memberRoleSchema>;

export const MEMBER_STATES = ["joined", "left", "removed"] as const;
export const memberStateSchema = z.enum(MEMBER_STATES);
export type MemberState = z.infer<typeof memberStateSchema>;

export const LEAF_STATES = ["pending_welcome", "active", "removed"] as const;
export const leafStateSchema = z.enum(LEAF_STATES);
export type LeafState = z.infer<typeof leafStateSchema>;

export const MAX_GROUP_MEMBERS = 255;

/** The MLS `group_id`, base64. Chosen by the creator, unique server-wide. */
export const mlsGroupIdSchema = base64Schema(128);

export const conversationMemberSchema = z.object({
  accountId: accountIdSchema,
  role: memberRoleSchema,
  state: memberStateSchema,
  joinedAt: isoDateSchema,
});
export type ConversationMember = z.infer<typeof conversationMemberSchema>;

export const conversationLeafSchema = z.object({
  instanceId: instanceIdSchema,
  accountId: accountIdSchema,
  state: leafStateSchema,
  addedEpoch: nonNegativeIntSchema,
});
export type ConversationLeaf = z.infer<typeof conversationLeafSchema>;

export const conversationSummarySchema = z.object({
  id: conversationIdSchema,
  kind: conversationKindSchema,
  appId: appIdSchema,
  mlsGroupId: mlsGroupIdSchema,
  epoch: nonNegativeIntSchema,
  lastSeq: nonNegativeIntSchema,
  members: z.array(conversationMemberSchema),
  leaves: z.array(conversationLeafSchema),
  /** The calling instance's leaf state, `null` when it holds no leaf. */
  myLeafState: leafStateSchema.nullable(),
  createdByAccountId: accountIdSchema,
  createdAt: isoDateSchema,
});
export type ConversationSummary = z.infer<typeof conversationSummarySchema>;

/**
 * `POST /v1/conversations`. `memberAccountIds` are the OTHER members: exactly
 * one for a DM, up to {@link MAX_GROUP_MEMBERS} for a group. The creator is
 * implied and must not be listed. `initialCommit` is a commit at epoch 0 that
 * adds their leaves and, in its `welcome`, lets them in.
 */
export const createConversationRequestSchema = z
  .object({
    kind: conversationKindSchema,
    mlsGroupId: mlsGroupIdSchema,
    memberAccountIds: z.array(accountIdSchema).max(MAX_GROUP_MEMBERS),
    idempotencyKey: idempotencyKeySchema,
    initialCommit: submitEventRequestSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kind === "dm" && v.memberAccountIds.length !== 1) {
      ctx.addIssue({ code: "custom", path: ["memberAccountIds"], message: "a dm names exactly one other account" });
    }
    if (new Set(v.memberAccountIds).size !== v.memberAccountIds.length) {
      ctx.addIssue({ code: "custom", path: ["memberAccountIds"], message: "an account is listed twice" });
    }
    if (v.initialCommit !== undefined) {
      if (v.initialCommit.kind !== "mls_commit") {
        ctx.addIssue({ code: "custom", path: ["initialCommit", "kind"], message: "the initial commit is an mls_commit" });
      }
      if (v.initialCommit.epoch !== 0) {
        ctx.addIssue({ code: "custom", path: ["initialCommit", "epoch"], message: "the initial commit is at epoch 0" });
      }
    }
  });
export type CreateConversationRequest = z.infer<typeof createConversationRequestSchema>;

export const createConversationResponseSchema = z.object({
  conversation: conversationSummarySchema,
  /** `false` when a DM already existed for the pair and that one was returned. */
  created: z.boolean(),
});
export type CreateConversationResponse = z.infer<typeof createConversationResponseSchema>;

/** `GET /v1/conversations` */
export const listConversationsResponseSchema = z.object({
  conversations: z.array(conversationSummarySchema),
});
export type ListConversationsResponse = z.infer<typeof listConversationsResponseSchema>;

/** `GET /v1/conversations/:id` */
export const conversationResponseSchema = z.object({
  conversation: conversationSummarySchema,
});
export type ConversationResponse = z.infer<typeof conversationResponseSchema>;

/**
 * The `dm_key` a DM is unique on: `${appId}:${a}:${b}` with the two account
 * ids in lexical order, so both ends compute the same key. A self-DM is
 * refused rather than keyed.
 */
export function dmKeyFor(appId: string, accountA: string, accountB: string): string {
  if (accountA === accountB) throw new RangeError("a dm needs two different accounts");
  return `${appId}:${[accountA, accountB].sort().join(":")}`;
}
