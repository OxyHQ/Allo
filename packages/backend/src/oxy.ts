import { OXY_API_URL, OXY_CLOUD_URL } from '@oxy.so/core';
import { createAwsWorkloadCredentialProvider } from '@oxy.so/core/server/aws';
import { OxyServer } from '@oxy.so/core/server';

/** Shared backend client. Own calls attest the registered workload and environment
 * through the SDK; no application key or internal OAuth scopes (Oxy ADR 0049).
 */
export const workloadCredentials = createAwsWorkloadCredentialProvider();
export const oxy = new OxyServer({
  workloadCredentials,
  baseURL: process.env.OXY_API_URL || OXY_API_URL,
  cloudURL: OXY_CLOUD_URL,
});
