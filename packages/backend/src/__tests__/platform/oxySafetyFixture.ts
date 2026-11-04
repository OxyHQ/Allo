import { generateKeyPairSync, sign } from 'node:crypto';
import { OxyServer } from '@oxy.so/core/server';
import { ALLO_SERVICE_AUDIENCE } from '../../config/oxyApplication';
/** External authority fixture. The real published SDK performs transport/schema
 * validation; Allo never substitutes a policy evaluator in production. */
import {
  accountActorChainFromSession,
  messagingSessionsInputSchema,
  deliveryAccessBatchInputSchema,
  messageAccessBatchInputSchema,
  safetySessionInputSchema,
} from '@oxy.so/contracts';

function token(claims: Record<string, unknown>): string {
  return `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.fixture-signature`;
}
export function fixtureBearer(accountId: string): string {
  return token({
    type: 'user',
    userId: accountId,
    sessionId: `fixture-${accountId}`,
    exp: Math.floor(Date.now() / 1000) + 3600,
  });
}
/**
 * Workload service tokens are shaped like Oxy's (EdDSA under a published kid,
 * oxy ADR 0012), so `oxy.middleware.service()` verifies them for real: the
 * public half is served at `/.well-known/jwks.json`, and every minted token is
 * live in `/auth/resources/introspect`.
 */
const SERVICE_KID = 'allo-fixture-key';
const serviceKeys = generateKeyPairSync('ed25519');
const liveServiceTokens = new Map<string, Record<string, unknown>>();
function serviceToken(audience: string): string {
  const iat = Math.floor(Date.now() / 1000);
  const claims = {
    iat,
    exp: iat + 300,
    type: 'service',
    iss: 'oxy-auth',
    aud: audience,
    tier: 'internal',
    authority: 'first_party',
    appId: 'allo-fixture',
    appName: 'Allo',
    credentialId: 'wl_allo_fixture',
    ownerAccountId: 'allo-fixture-owner',
    environment: 'development',
  };
  const header = Buffer.from(
    JSON.stringify({ alg: 'EdDSA', typ: 'JWT', kid: SERVICE_KID }),
  ).toString('base64url');
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = sign(null, Buffer.from(`${header}.${payload}`), serviceKeys.privateKey);
  const signed = `${header}.${payload}.${signature.toString('base64url')}`;
  liveServiceTokens.set(signed, {
    active: true,
    authority: 'first_party',
    applicationId: claims.appId,
    credentialId: claims.credentialId,
    accountId: claims.ownerAccountId,
    environment: claims.environment,
    audience,
    expiresAt: new Date(claims.exp * 1000).toISOString(),
  });
  return signed;
}
const actors = new Map<string, string>();
export function registerFixtureActor(accountId: string): string {
  const bearer = fixtureBearer(accountId);
  actors.set(bearer, accountId);
  return bearer;
}
export const safetyFixture = {
  supervised: new Set<string>(),
  revoked: new Set<string>(),
  blocked: new Set<string>(),
  contacts: new Set<string>(),
  /** Accounts `POST /users/by-ids` knows; every other id is answered as absent. */
  users: new Set<string>(),
  unavailable: false,
  enabled: true,
  calls: [] as { path: string; body: unknown }[],
  pair(a: string, b: string) {
    return [a, b].sort().join('|');
  },
  reset() {
    this.supervised.clear();
    this.revoked.clear();
    this.blocked.clear();
    this.contacts.clear();
    this.users.clear();
    this.unavailable = false;
    this.enabled = true;
    this.calls = [];
  },
};
const json = (data: unknown, status = 200) => Response.json(data, { status });
function session(bearer: string, reviewed: boolean) {
  const accountId = actors.get(bearer);
  if (!accountId || safetyFixture.revoked.has(accountId))
    return json({ message: 'Session unavailable' }, 401);
  if (safetyFixture.supervised.has(accountId) && (!reviewed || !safetyFixture.enabled))
    return json({ message: 'Unsupported action' }, 403);
  return json({
    valid: true,
    sessionId: `fixture-${accountId}`,
    expiresAt: new Date(Date.now() + 3600000).toISOString(),
    lastActivity: new Date().toISOString(),
    user: { id: accountId, username: accountId, name: { displayName: accountId } },
    actor: accountActorChainFromSession({ subjectAccountId: accountId }),
  });
}
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(req) {
    const path = new URL(req.url).pathname;
    const raw = req.method === 'POST' ? await req.text() : '';
    const body = raw ? JSON.parse(raw) : undefined;
    safetyFixture.calls.push({ path, body });
    if (safetyFixture.unavailable) return json({ message: 'Authority unavailable' }, 503);
    if (path === '/auth/service-token/workload/challenge')
      return json({ nonce: 'allo-test-nonce' });
    if (path === '/auth/service-token/workload')
      return json({
        token: serviceToken(body.audience ?? 'oxy-api'),
        expiresIn: 300,
        appName: 'Allo',
      });
    if (path === '/.well-known/jwks.json')
      return json({
        keys: [
          {
            ...serviceKeys.publicKey.export({ format: 'jwk' }),
            kid: SERVICE_KID,
            alg: 'EdDSA',
            use: 'sig',
          },
        ],
      });
    if (path === '/auth/resources/introspect') {
      const receiver = req.headers.get('authorization')?.slice(7) ?? '';
      if (!liveServiceTokens.has(receiver)) return json({ message: 'Unauthorized' }, 401);
      return json(liveServiceTokens.get(body.token) ?? { active: false });
    }
    if (path === '/users/by-ids')
      return json(
        (body.ids as string[])
          .filter((id) => safetyFixture.users.has(id))
          .map((id) => ({ id, username: `user-${id.slice(-4)}`, name: { displayName: id } })),
      );
    if (path.startsWith('/session/validate-header/'))
      return session(req.headers.get('authorization')?.slice(7) ?? '', false);
    if (path === '/safety/service/session') {
      const input = safetySessionInputSchema.parse(body);
      return session(input.accessToken, true);
    }
    if (path === '/safety/service/messaging-sessions') {
      const { items } = messagingSessionsInputSchema.parse(body);
      return json({
        items: items.map((item) => {
          const accountId = actors.get(item.accessToken);
          return accountId &&
            !safetyFixture.revoked.has(accountId) &&
            (!safetyFixture.supervised.has(accountId) || safetyFixture.enabled)
            ? { requestId: item.requestId, allowed: true, accountId }
            : { requestId: item.requestId, allowed: false };
        }),
      });
    }
    if (
      path === '/safety/service/message-access-batch' ||
      path === '/safety/service/delivery-access-batch'
    ) {
      const delivery = path.includes('delivery');
      const parsed = delivery
        ? deliveryAccessBatchInputSchema.parse(body)
        : messageAccessBatchInputSchema.parse(body.input);
      const actor = delivery ? null : actors.get(body.requester.accessToken);
      if (!delivery && (!actor || safetyFixture.revoked.has(actor)))
        return json({ message: 'Invalid requester' }, 401);
      return json({
        items: parsed.items.map((item) => {
          const ids = item.participantAccountIds;
          let reason = 'allowed';
          if (ids.some((id) => safetyFixture.revoked.has(id))) reason = 'unavailable';
          if (ids.some((a) => ids.some((b) => safetyFixture.blocked.has(safetyFixture.pair(a, b)))))
            reason = 'blocked';
          if (
            ids.some(
              (a) =>
                safetyFixture.supervised.has(a) &&
                ids.some((b) => a !== b && !safetyFixture.contacts.has(safetyFixture.pair(a, b))),
            )
          )
            reason = 'contact_not_approved';
          if (
            ids.some((id) => safetyFixture.supervised.has(id)) &&
            (!safetyFixture.enabled || ids.length > 256)
          )
            reason = 'unsupported_consumer';
          return {
            resourceId: item.resourceId,
            decision: { allowed: reason === 'allowed', reason, policyVersion: '2' },
          };
        }),
      });
    }
    return json({ message: `Unhandled Oxy fixture path ${path}` }, 501);
  },
});
server.unref();
export const fixtureWorkloadCredentials = async () => ({
  AccessKeyId: 'AKIAALLOFIXTURE',
  SecretAccessKey: 'fixture-signing-secret',
});
export const fixtureOxy = new OxyServer({
  baseURL: server.url.origin,
  workloadCredentials: fixtureWorkloadCredentials,
  expectedAudience: ALLO_SERVICE_AUDIENCE,
});
