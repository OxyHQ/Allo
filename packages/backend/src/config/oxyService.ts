import { canAttestWorkloadIdentity } from '@oxy.so/core/server';

/** Own service identity is an attested, registered workload (Oxy ADR 0049).
 * Customer API credentials never substitute for Allo's workload identity.
 * Public directory lookups remain available without a workload.
 */
export function canAuthenticateAsOxyService(environment: NodeJS.ProcessEnv = process.env): boolean {
  return canAttestWorkloadIdentity(environment);
}
