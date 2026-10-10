import { test, expect } from 'bun:test';

const entries = ['../packages/frontend/worker/index.js'];
for (const entry of entries) {
  test(`${entry}: preserves assets while publishing anonymous incoming/outgoing counts`, async () => {
    const worker = (await import(entry)).default;
    const response = new Response('asset', {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public,max-age=31536000,immutable',
      },
    });
    const request = new Request('https://example.com/private-image.png?user=secret', {
      headers: { 'CF-Connecting-IP': '203.0.113.2' },
    });
    Object.assign(request, { cf: { colo: 'MAD' } });
    const calls: { url: string; init?: RequestInit }[] = [];
    const tasks: Promise<unknown>[] = [];
    const oldFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return String(input).endsWith('/auth/service-token')
        ? Response.json({ token: 'token', expiresIn: 3600 })
        : new Response(null, { status: 204 });
    }) as typeof fetch;
    try {
      const result = await worker.fetch(
        request,
        {
          ASSETS: { fetch: async () => response },
          OXY_EDGE_ACTIVITY_ENABLED: 'true',
          OXY_EDGE_ACTIVITY_API_KEY: 'key',
          OXY_EDGE_ACTIVITY_API_SECRET: 'secret',
        },
        { waitUntil: (p: Promise<unknown>) => tasks.push(p) },
      );
      expect(result.status).toBe(200);
      expect(result.headers.get('Cache-Control')).toContain('immutable');
      expect(await result.text()).toBe('asset');
      await Promise.all(tasks);
      expect(calls.map((c) => c.url)).toEqual([
        'https://api.oxy.so/auth/service-token',
        'https://api.oxy.so/internal/activity',
      ]);
      const body = String(calls[1].init?.body);
      expect(body).not.toMatch(/private-image|secret|203\.0|example.com/);
      const events = JSON.parse(body);
      expect(events.map((event: { direction: string }) => event.direction)).toEqual([
        'inbound',
        'outbound',
      ]);
      expect(events[0]).toMatchObject({
        region: 'edge-mad',
        scope: 'external',
        activityType: 'media',
      });
    } finally {
      globalThis.fetch = oldFetch;
    }
  });
  test(`${entry}: asset failures preserve the original error with monitoring disabled`, async () => {
    const worker = (await import(entry)).default;
    const error = new Error('asset failure');
    await expect(
      worker.fetch(
        new Request('https://example.com/file.png'),
        {
          ASSETS: {
            fetch: async () => {
              throw error;
            },
          },
        },
        {
          waitUntil: () => {
            throw new Error('disabled activity');
          },
        },
      ),
    ).rejects.toBe(error);
  });
}

// `/.well-known/*` is answered by the Worker itself (`worker/appAssociation.js`)
// and must never reach the assets binding, whose single-page-application
// fallback would answer it with `index.html` and 200. The Matrix delegation
// documents that used to be served from there were deleted with the Matrix stack
// (docs/adr/0001-clean-break-platform.md), so `/.well-known/matrix/*` is now a
// JSON 404 like every other unclaimed `/.well-known` path. This is the composed
// Worker, telemetry wrapper included; `__tests__/appAssociation.test.ts` covers
// the handler on its own.
test('/.well-known is answered by the Worker as JSON and never reaches the asset binding', async () => {
  const worker = (await import('../packages/frontend/worker/index.js')).default;
  const cases: [string, number][] = [
    ['/.well-known/assetlinks.json', 200],
    ['/.well-known/matrix/server', 404],
    ['/.well-known/matrix/client', 404],
  ];
  for (const [path, status] of cases) {
    let assetCalls = 0;
    const result = await worker.fetch(
      new Request(`https://allo.you${path}`),
      {
        ASSETS: {
          fetch: async () => {
            assetCalls += 1;
            return new Response('<!doctype html>', { headers: { 'Content-Type': 'text/html' } });
          },
        },
      },
      { waitUntil: () => {} },
    );
    expect(assetCalls).toBe(0);
    expect(result.status).toBe(status);
    expect(result.headers.get('Content-Type')).toContain('application/json');
    JSON.parse(await result.text());
  }
});
