import { OXY_API_URL, OXY_CLOUD_URL } from '@oxy.so/core';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OxyServer } from '@oxy.so/core/server';
import { ALLO_APPLICATION_ID, ALLO_SERVICE_AUDIENCE } from './config/oxyApplication';

/**
 * The one Oxy client in this process (`@oxy.so/core`'s `docs/backend.mdx`).
 *
 * It authenticates as Allo's attested workload (Oxy ADR 0049) — no application
 * key, no internal OAuth scopes. `serviceIdentity: 'when-anonymous'` sends
 * every session-less read (the directory's `users.*`, moderation's
 * `users.get`) with that service token instead of anonymous, which oxy-api
 * charges to the fleet's shared NAT address and slows past 100 requests per
 * 15 minutes. A local checkout that cannot attest keeps sending them
 * anonymous. `expectedAudience` is the audience every auth, service and
 * rate-limit mount accepts a service token for, named once here.
 */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
export const oxy = new OxyServer({
  workloadCredentials,
  baseURL: process.env.OXY_API_URL || OXY_API_URL,
  cloudURL: OXY_CLOUD_URL,
  applicationId: ALLO_APPLICATION_ID,
  serviceIdentity: 'when-anonymous',
  expectedAudience: ALLO_SERVICE_AUDIENCE,
});
