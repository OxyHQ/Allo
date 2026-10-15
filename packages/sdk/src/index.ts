import { TEAM_CAPABILITY_HEADER, teamSnapshotSchema, type TeamSnapshot } from '@allo/contracts';
export type { TeamSnapshot } from '@allo/contracts';
/** Resource-scoped read access. This capability confers no write or message access. */
export class AlloTeamAccessClient {
  constructor(private readonly fetcher: typeof fetch = globalThis.fetch.bind(globalThis)) {}
  async snapshot(capability: string): Promise<TeamSnapshot | null> {
    const response = await this.fetcher('https://api.allo.you/v1/team-access/snapshot', {
      method: 'POST', headers: { [TEAM_CAPABILITY_HEADER]: capability },
      cache: 'no-store', redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error('Allo team access is unavailable');
    return teamSnapshotSchema.parse(await response.json());
  }
}
