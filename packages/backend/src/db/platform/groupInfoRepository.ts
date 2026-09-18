/**
 * `conversation_group_info` — the stored GroupInfo, one row per conversation.
 *
 * Written by {@link upsertGroupInfo} from inside `appendClientEvent`'s
 * transaction (every accepted `mls_commit`) and from `PUT …/group-info`
 * (a re-publish for the current epoch). Read by {@link findGroupInfo} for
 * `GET …/group-info`, which is the one place `data` — a protected column —
 * legitimately leaves the process, to a joined member of the conversation.
 */

import { eq } from "drizzle-orm";
import { getDb, type AlloDatabaseOrTransaction } from "../index";
import { requireTransaction } from "../moderation/transactionGuard";
import { conversationGroupInfo } from "../schema/conversations";

export type GroupInfoRow = typeof conversationGroupInfo.$inferSelect;

export interface UpsertGroupInfoInput {
  conversationId: string;
  epoch: number;
  signerInstanceId: string;
  data: Buffer;
}

/**
 * Insert, or replace whatever the conversation held. The caller holds the
 * conversation's `FOR UPDATE` lock and has already decided `epoch` is the
 * epoch the row should describe (the commit's `newEpoch`, or the current
 * epoch for a re-publish), so there is no monotonicity check here: under the
 * lock the epoch only moves forward, and a re-publish is for the current one.
 */
export async function upsertGroupInfo(input: UpsertGroupInfoInput, db: AlloDatabaseOrTransaction): Promise<void> {
  const tx = requireTransaction(db, `upsertGroupInfo(${input.conversationId})`);
  const now = new Date();
  await tx
    .insert(conversationGroupInfo)
    .values({
      conversationId: input.conversationId,
      epoch: input.epoch,
      signerInstanceId: input.signerInstanceId,
      data: input.data,
    })
    .onConflictDoUpdate({
      target: conversationGroupInfo.conversationId,
      set: { epoch: input.epoch, signerInstanceId: input.signerInstanceId, data: input.data, updatedAt: now },
    });
}

/** Protected-column opt-in: `data` is what `GET …/group-info` exists to hand a joined member. */
export async function findGroupInfo(
  conversationId: string,
  db: AlloDatabaseOrTransaction = getDb(),
): Promise<GroupInfoRow | null> {
  const [row] = await db
    .select()
    .from(conversationGroupInfo)
    .where(eq(conversationGroupInfo.conversationId, conversationId))
    .limit(1);
  return row ?? null;
}
