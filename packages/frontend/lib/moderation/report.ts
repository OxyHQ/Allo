import { authenticatedClient } from '@/utils/api';

/** What a report is about. The backend accepts more; these are what a screen offers. */
export type ReportedType = 'user' | 'message';

/**
 * Report an account or a message.
 *
 * A 201 means the report is recorded. Allo's server cannot read a message, so a
 * reported message is stored and never delivered to CrowdSource — the response
 * deliberately does not say which is which (`backend/src/routes/reports.ts`),
 * and neither does this.
 */
export async function report(reportedType: ReportedType, reportedId: string, reason?: string): Promise<void> {
  await authenticatedClient.post('reports', { reportedType, reportedId, reason });
}
