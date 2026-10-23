import { expect, it } from 'bun:test';
import { OxyServices } from '@oxy.so/core';
import {
  EMPTY_BODY_SHA256_HEX,
  INSTANCE_HEADER,
  SIGNATURE_HEADER,
  SOCKET_SIGNING_PATH,
  TIMESTAMP_HEADER,
  signedRequestMessage,
} from '@allo/shared-types';
import { HttpClient } from '../transport/http';
import { buildSocketAuth } from '../transport/socket';
import { generateSigningKey, publicKeyBase64, verifyEd25519 } from '../crypto/signing';
import { sha256Hex, utf8Encode } from '../util/bytes';

function token(seconds: number, revision: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${encode({ alg: 'none' })}.${encode({ userId: 'alice', sessionId: 'session-a', exp: Math.floor(Date.now() / 1000) + seconds, revision })}.fixture`;
}
it('sends shared fresh HTTP authority with the unchanged instance signature and fresh socket proof', async () => {
  const key = generateSigningKey();
  const now = Date.now();
  let received = 0;
  const fresh = token(3600, 2);
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      received += 1;
      expect(req.headers.get('authorization')).toBe(`Bearer ${fresh}`);
      expect(req.headers.get(INSTANCE_HEADER)).toBe('instance-a');
      const body = await req.text();
      expect(body).toBe(JSON.stringify({ message: 'ciphertext' }));
      const url = new URL(req.url);
      expect(
        verifyEd25519(
          publicKeyBase64(key),
          signedRequestMessage({
            method: req.method,
            pathWithQuery: url.pathname + url.search,
            timestampMs: Number(req.headers.get(TIMESTAMP_HEADER)),
            bodySha256Hex: sha256Hex(utf8Encode(body)),
          }),
          req.headers.get(SIGNATURE_HEADER) ?? '',
        ),
      ).toBe(true);
      return new Response(null, { status: 204 });
    },
  });
  const oxy = new OxyServices({ baseURL: server.url.origin });
  oxy.session.setAccessToken(token(1, 1));
  let refreshes = 0;
  oxy.http.setAuthRefreshHandler(async () => {
    refreshes += 1;
    return fresh;
  });
  const linked = oxy.createLinkedClient({ baseURL: server.url.origin });
  try {
    const http = new HttpClient({
      baseUrl: server.url.origin,
      fetch: linked.fetch,
      now: () => now,
    });
    await http.request({
      method: 'POST',
      path: '/v1/action?cursor=1',
      body: { message: 'ciphertext' },
      headers: { authorization: 'Bearer forged' },
      signer: { instanceId: 'instance-a', key },
    });
    expect(received).toBe(1);
    expect(refreshes).toBe(1);
    const handshake = buildSocketAuth({
      token: await linked.getAccessToken(server.url),
      instanceId: 'instance-a',
      key,
      now,
    });
    expect(handshake.token).toBe(fresh);
    expect(
      verifyEd25519(
        publicKeyBase64(key),
        signedRequestMessage({
          method: 'GET',
          pathWithQuery: SOCKET_SIGNING_PATH,
          timestampMs: handshake.timestamp,
          bodySha256Hex: EMPTY_BODY_SHA256_HEX,
        }),
        handshake.signature,
      ),
    ).toBe(true);
    oxy.session.clear();
    await expect(linked.getAccessToken(server.url)).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
    expect(received).toBe(1);
  } finally {
    linked.dispose();
    oxy.dispose();
    server.stop(true);
  }
});
