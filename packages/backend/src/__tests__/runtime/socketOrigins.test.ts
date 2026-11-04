import { afterAll, beforeAll, expect, it } from 'bun:test';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSocketServer, type SocketRuntime } from '../../runtime/socket';

/**
 * The socket admits the browsers `createOxyCors` admits over HTTP — Allo's own
 * origins plus the Oxy apex family — and no other, on the long-polling
 * handshake as on the WebSocket one (`createOxySocketCors`). A native client
 * sends no Origin and is admitted to authenticate like any socket.
 */

const refuseEverySession = {
  middleware: {
    socket: () => async (_socket: unknown, next: (err?: Error) => void) =>
      next(new Error('unauthorized')),
  },
};

let server: http.Server;
let sockets: SocketRuntime;
let base: string;

beforeAll(async () => {
  server = http.createServer();
  sockets = createSocketServer(server, { oxy: refuseEverySession });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.presence.stop();
  await new Promise<void>((resolve) => sockets.io.close(() => resolve()));
});

async function handshake(origin?: string) {
  const response = await fetch(`${base}/socket.io/?EIO=4&transport=polling`, {
    headers: origin === undefined ? {} : { Origin: origin },
  });
  await response.text();
  return {
    status: response.status,
    allowOrigin: response.headers.get('access-control-allow-origin'),
  };
}

it('admits Allo and the Oxy apex family, and a client that sends no Origin', async () => {
  for (const origin of ['https://allo.you', 'https://accounts.oxy.so', 'https://oxy.so']) {
    const answer = await handshake(origin);
    expect(answer.status).toBe(200);
    expect(answer.allowOrigin).toBe(origin);
  }
  expect((await handshake()).status).toBe(200);
});

it('refuses every other browser origin', async () => {
  for (const origin of [
    'https://evil.example',
    'https://allo.you.evil.example',
    'http://accounts.oxy.so',
    'https://a.b.oxy.so',
    'null',
  ]) {
    const answer = await handshake(origin);
    expect(answer.status).not.toBe(200);
    expect(answer.allowOrigin).toBeNull();
  }
});
