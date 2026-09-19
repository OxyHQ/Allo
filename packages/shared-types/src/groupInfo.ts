/**
 * The stored `GroupInfo` of a conversation: what a device that is a member
 * with no active leaf joins from, by MLS external commit, with nobody else
 * online. One per conversation, for the CURRENT epoch only; every
 * `mls_commit` replaces it (`CommitInfo.groupInfo`) and a member may
 * re-publish it for a conversation whose last commit predates the field.
 * The server never reads it.
 */
import { z } from "zod";
import { base64Schema, instanceIdSchema, isoDateSchema, nonNegativeIntSchema } from "./common";
import { GROUP_INFO_MAX_BASE64 } from "./events";

export const storedGroupInfoSchema = z.object({
  /** The epoch the GroupInfo describes — the conversation's current epoch when it is served. */
  epoch: nonNegativeIntSchema,
  /** The instance whose commit (or re-publish) produced it. */
  signerInstanceId: instanceIdSchema,
  /** The serialized GroupInfo (with `external_pub` and `ratchet_tree`), base64. */
  data: base64Schema(GROUP_INFO_MAX_BASE64),
  createdAt: isoDateSchema,
});
export type StoredGroupInfo = z.infer<typeof storedGroupInfoSchema>;

/**
 * `GET /v1/conversations/:id/group-info`. `null` when the server holds none
 * for the current epoch: a conversation whose last commit predates the
 * field. The joiner then waits for an elector as before.
 */
export const groupInfoResponseSchema = z.object({
  groupInfo: storedGroupInfoSchema.nullable(),
});
export type GroupInfoResponse = z.infer<typeof groupInfoResponseSchema>;

/**
 * `PUT /v1/conversations/:id/group-info`. Re-publishes for the CURRENT epoch
 * only; any other `epoch` is `epoch_conflict`. The caller must hold an active leaf.
 */
export const putGroupInfoRequestSchema = z.object({
  epoch: nonNegativeIntSchema,
  data: base64Schema(GROUP_INFO_MAX_BASE64),
});
export type PutGroupInfoRequest = z.infer<typeof putGroupInfoRequestSchema>;
