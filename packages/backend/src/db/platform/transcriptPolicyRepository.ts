/** Historical membership is Allo's durable transcript-author evidence.
 * appendClientEvent requires this row before every human event. Leaving/removal
 * changes state, never deletes the row; reset preserves it too. Read all states,
 * using the (conversation_id, account_id) unique index rather than scanning the
 * ciphertext log. The extra row is an overflow witness, never an allowed subset. */
import { sql } from 'drizzle-orm';
import { MESSAGE_ACCESS_MAX_PARTICIPANTS, MESSAGE_ACCESS_MAX_RESOURCES } from '@oxy.so/contracts';
import type { AlloDatabaseOrTransaction } from '../index';

export function transcriptParticipantsQuery(ids: readonly string[]) {
  const selected = sql.join(
    ids.map((id) => sql`(${id}::text)`),
    sql`, `,
  );
  return sql`
    SELECT requested.conversation_id, evidence.account_id
    FROM (VALUES ${selected}) AS requested(conversation_id)
    CROSS JOIN LATERAL (
      SELECT account_id FROM conversation_members
      WHERE conversation_id = requested.conversation_id
      ORDER BY account_id LIMIT ${MESSAGE_ACCESS_MAX_PARTICIPANTS + 1}
    ) evidence
  `;
}

export async function transcriptParticipants(
  ids: readonly string[],
  db: AlloDatabaseOrTransaction,
): Promise<Map<string, string[]>> {
  const result = new Map(ids.map((id) => [id, [] as string[]]));
  for (let offset = 0; offset < ids.length; offset += MESSAGE_ACCESS_MAX_RESOURCES) {
    const rows = await db.execute<{ conversation_id: string; account_id: string }>(
      transcriptParticipantsQuery(ids.slice(offset, offset + MESSAGE_ACCESS_MAX_RESOURCES)),
    );
    for (const row of rows) result.get(row.conversation_id)?.push(row.account_id);
  }
  return result;
}
