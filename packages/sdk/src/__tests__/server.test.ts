import { afterAll, afterEach, expect, it } from 'bun:test';
import { OxyServer } from '@oxy.so/core/server';
import * as root from '../index';
import { alloTeamForOxyService, SERVICE_AUDIENCE } from '../server';

const CAPABILITY = 'A'.repeat(43);
const OPERATION_ID = 'operation-1';
const TOKEN = `e30.${Buffer.from(JSON.stringify({ type: 'service', authority: 'first_party', exp: Math.floor(Date.now() / 1000) + 300 })).toString('base64url')}.signature`;
const SNAPSHOT = {
  conversationId: 'conversation-1',
  sourceReference: 'case-1',
  ownerAccountId: 'owner',
  memberAccountIds: ['member', 'owner'],
  epoch: 3,
  operationId: OPERATION_ID,
  frozen: false,
};
const issuer = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    if (new URL(req.url).pathname.endsWith('/challenge'))
      return Response.json({ nonce: 'fixture' });
    const body = await req.json();
    expect(body.protocolVersion).toBe(2);
    expect(body.audience).toBe(SERVICE_AUDIENCE);
    return Response.json({ token: TOKEN, expiresIn: 300 });
  },
});
afterAll(() => issuer.stop(true));

const original = globalThis.fetch;
const servers: OxyServer[] = [];
afterEach(() => {
  globalThis.fetch = original;
  for (const oxy of servers.splice(0)) oxy.dispose();
});

/** A workload OxyServer whose Allo requests are answered by `allo`. */
function team(allo: (req: Request) => Response) {
  const requests: Request[] = [];
  const oxy = new OxyServer({
    baseURL: issuer.url.origin,
    workloadCredentials: async () => ({
      AccessKeyId: 'ASIA_FIXTURE',
      SecretAccessKey: 'fixture',
      Token: 'fixture-session',
    }),
  });
  servers.push(oxy);
  globalThis.fetch = (async (input, init) => {
    const req = new Request(input, init);
    if (new URL(req.url).hostname !== 'api.allo.you') return original(input, init);
    requests.push(req);
    return allo(req);
  }) as typeof fetch;
  return { client: alloTeamForOxyService(oxy), requests };
}

it('offers no unauthenticated client: the root entry exports links and types only', () => {
  expect(Object.keys(root)).not.toContain('AlloTeamAccessClient');
  expect(Object.keys(root).every((name) => !/team/i.test(name))).toBe(true);
});

it('sends the service token AND the resource capability to the snapshot route', async () => {
  const { client, requests } = team(() => Response.json(SNAPSHOT));
  expect(await client.snapshot(CAPABILITY)).toEqual(SNAPSHOT);
  expect(requests).toHaveLength(1);
  const [req] = requests;
  expect(req.method).toBe('POST');
  expect(req.url).toBe('https://api.allo.you/v1/team-access/snapshot');
  expect(req.headers.get('authorization')).toBe(`Bearer ${TOKEN}`);
  expect(req.headers.get('x-allo-team-capability')).toBe(CAPABILITY);
});

it('answers null for a capability that names no team', async () => {
  const { client } = team(() => new Response(null, { status: 404 }));
  expect(await client.snapshot('revoked-capability')).toBeNull();
});

it('throws, never null, when Allo refuses the transport identity or is down', async () => {
  for (const status of [401, 403, 503]) {
    const { client } = team(() => new Response(null, { status }));
    await expect(client.snapshot(CAPABILITY)).rejects.toThrow('Allo team access is unavailable');
  }
});

it('refuses a response that is not a team snapshot', async () => {
  const { client } = team(() => Response.json({ conversationId: 1 }));
  await expect(client.snapshot(CAPABILITY)).rejects.toThrow();
});
