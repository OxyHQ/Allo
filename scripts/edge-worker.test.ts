import { expect, test } from 'bun:test';

// The allo-frontend Worker (`packages/frontend/worker/index.js`), composed as it
// is deployed. `__tests__/appAssociation.test.ts` covers the `/.well-known`
// handler on its own.
const entry = '../packages/frontend/worker/index.js';

test('an asset response is returned untouched: status, headers and body', async () => {
  const worker = (await import(entry)).default;
  const response = new Response('asset', {
    headers: {
      'Content-Type': 'image/png',
      'Cache-Control': 'public,max-age=31536000,immutable',
    },
  });
  const request = new Request('https://allo.you/image.png?v=1');
  const seen: Request[] = [];
  const result = await worker.fetch(
    request,
    {
      ASSETS: {
        fetch: async (forwarded: Request) => {
          seen.push(forwarded);
          return response;
        },
      },
    },
    { waitUntil: () => {} },
  );
  expect(seen).toEqual([request]);
  expect(result).toBe(response);
  expect(result.status).toBe(200);
  expect(result.headers.get('Cache-Control')).toContain('immutable');
  expect(await result.text()).toBe('asset');
});

test('an asset failure propagates the original error', async () => {
  const worker = (await import(entry)).default;
  const error = new Error('asset failure');
  await expect(
    worker.fetch(
      new Request('https://allo.you/file.png'),
      {
        ASSETS: {
          fetch: async () => {
            throw error;
          },
        },
      },
      { waitUntil: () => {} },
    ),
  ).rejects.toBe(error);
});

// `/.well-known/*` is answered by the Worker itself (`worker/appAssociation.js`)
// and must never reach the assets binding, whose single-page-application
// fallback would answer it with `index.html` and 200. The Matrix delegation
// documents that used to be served from there were deleted with the Matrix stack
// (docs/adr/0001-clean-break-platform.md), so `/.well-known/matrix/*` is now a
// JSON 404 like every other unclaimed `/.well-known` path.
test('/.well-known is answered by the Worker as JSON and never reaches the asset binding', async () => {
  const worker = (await import(entry)).default;
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
