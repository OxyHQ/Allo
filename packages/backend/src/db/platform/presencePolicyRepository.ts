/** Local presence preferences and relationship checks for a bounded set of pairs. */
import { sql } from 'drizzle-orm';
import type { AlloDatabaseOrTransaction } from '../index';

export interface PresencePair {
  requestId: string;
  viewerId: string;
  subjectId: string;
}
export async function visiblePresencePairs(
  db: AlloDatabaseOrTransaction,
  pairs: readonly PresencePair[],
): Promise<Set<string>> {
  const visible = new Set<string>();
  for (let offset = 0; offset < pairs.length; offset += 1000) {
    const values = sql.join(
      pairs
        .slice(offset, offset + 1000)
        .map(
          (pair) => sql`(${pair.requestId}::text,${pair.viewerId}::text,${pair.subjectId}::text)`,
        ),
      sql`, `,
    );
    const rows = await db.execute<{ request_id: string }>(sql`
      WITH requested(request_id,viewer_id,subject_id) AS (VALUES ${values})
      SELECT r.request_id FROM requested r
      WHERE r.viewer_id <> r.subject_id
      AND NOT EXISTS (SELECT 1 FROM user_settings s WHERE s.oxy_user_id IN (r.viewer_id,r.subject_id) AND NOT s.privacy_show_online_status)
      AND NOT EXISTS (SELECT 1 FROM blocks b WHERE (b.user_id=r.viewer_id AND b.blocked_id=r.subject_id) OR (b.user_id=r.subject_id AND b.blocked_id=r.viewer_id))
      AND EXISTS (SELECT 1 FROM conversation_members a JOIN conversation_members b ON a.conversation_id=b.conversation_id
        WHERE a.account_id=r.viewer_id AND b.account_id=r.subject_id AND a.state='joined' AND b.state='joined')
    `);
    for (const row of rows) visible.add(row.request_id);
  }
  return visible;
}
