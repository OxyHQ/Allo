import {
  TEAM_CAPABILITY_HEADER,
  teamSnapshotSchema,
  type TeamSnapshot,
} from '@oxy.so/allo-contracts';
import type { OxyServer } from '@oxy.so/core/server';

const ALLO_API_ORIGIN = 'https://api.allo.you';

/** Allo's Oxy application, addressed as the receiver of the service token. */
export const SERVICE_AUDIENCE = 'oxy-service:6a2f851751b784a86fd0e92b';

/** Resource-scoped read access. This capability confers no write or message access. */
export interface AlloTeamAccessClient {
  /** The team's coherent membership snapshot, or `null` when the capability names no team. */
  snapshot(capability: string): Promise<TeamSnapshot | null>;
}

/**
 * The only way to read a team snapshot: every request carries this process's
 * Oxy service token (transport identity) AND the team's capability (resource
 * grant). Neither replaces the other. The transport is pinned to Allo's origin,
 * refuses redirects and never caches.
 */
export function alloTeamForOxyService(oxy: OxyServer): AlloTeamAccessClient {
  const { fetch } = oxy.createServiceClient({
    baseURL: ALLO_API_ORIGIN,
    audience: SERVICE_AUDIENCE,
  });
  return {
    async snapshot(capability) {
      const response = await fetch(`${ALLO_API_ORIGIN}/v1/team-access/snapshot`, {
        method: 'POST',
        headers: { [TEAM_CAPABILITY_HEADER]: capability },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error('Allo team access is unavailable');
      return teamSnapshotSchema.parse(await response.json());
    },
  };
}
