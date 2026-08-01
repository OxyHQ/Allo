// Static file server for the exported web build. Deliberately dumb: it only
// serves what `expo export` produced, so anything that works here works on any
// static host (Cloudflare Pages included).
//
// It sets `application/wasm` explicitly because that MIME type is exactly what
// `WebAssembly.instantiateStreaming` requires, and getting it wrong is one of
// the failure modes this spike is meant to catch.
const DIST = new URL('../dist/', import.meta.url).pathname;
const PORT = Number(process.env.PORT ?? 8142);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.ico': 'image/x-icon',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

function mimeFor(pathname: string): string | undefined {
  const dot = pathname.lastIndexOf('.');
  if (dot === -1) return undefined;
  return MIME[pathname.slice(dot).toLowerCase()];
}

const server = Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);
    const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
    const filePath = DIST + pathname.replace(/^\//, '');

    const file = Bun.file(filePath);
    if (await file.exists()) {
      const type = mimeFor(pathname);
      const headers = new Headers();
      if (type !== undefined) headers.set('Content-Type', type);
      console.log(`200 ${pathname}${type === undefined ? '' : ` (${type})`}`);
      return new Response(file, { headers });
    }

    // Single-page fallback, mirroring the `_redirects` rule the real frontend
    // ships in packages/frontend/public/.
    const index = Bun.file(DIST + 'index.html');
    if (await index.exists()) {
      console.log(`200 ${pathname} -> index.html (fallback)`);
      return new Response(index, { headers: { 'Content-Type': MIME['.html'] as string } });
    }

    console.log(`404 ${pathname}`);
    return new Response('not found', { status: 404 });
  },
});

console.log(`serving ${DIST} on http://localhost:${server.port}`);
