import type { OxyServer } from '@oxy.so/core/server';
import { AlloTeamAccessClient } from './index';

export const SERVICE_AUDIENCE = 'oxy-service:6a2f851751b784a86fd0e92b';

/** Own transport identity does not replace the team's resource capability. */
export function alloTeamForOxyService(oxy: OxyServer): AlloTeamAccessClient {
  const client = oxy.createServiceClient({
    baseURL: 'https://api.allo.you',
    audience: SERVICE_AUDIENCE,
  });
  return new AlloTeamAccessClient(client.fetch);
}
