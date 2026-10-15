/** Real Chromium media, real adapter, actual React video component. Optional
 * local LiveKit verifies SFU encryption independently of signalling fixtures.
 * ALLO_CALL_LIVEKIT_BINARY=/absolute/path/livekit-server bun run test:call-media:browser
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const root = resolve(import.meta.dir, '../..');
process.chdir(root);
const output = '.local/call-media-browser';
await mkdir(output, { recursive: true });
const build = await Bun.build({
  entrypoints: ['scripts/call-media-browser/entry.tsx'],
  outdir: output,
  target: 'browser',
  plugins: [
    {
      name: 'platform-test',
      setup(builder) {
        builder.onResolve({ filter: /^\.\/globals$/ }, () => ({
          path: `${root}/packages/frontend/lib/calls/globals.web.ts`,
        }));
        builder.onResolve({ filter: /^\.\/encryption$/ }, () => ({
          path: `${root}/packages/frontend/lib/calls/encryption.web.ts`,
        }));
        builder.onResolve({ filter: /^@\/utils\/logger$/ }, () => ({
          path: `${root}/scripts/call-media-browser/logger.ts`,
        }));
      },
    },
  ],
});
if (!build.success) throw new Error(build.logs.map(String).join('\n'));
const server = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/')
      return new Response(
        '<div id="root" style="width:640px;height:480px"></div><script src="/entry.js"></script>',
        { headers: { 'Content-Type': 'text/html' } },
      );
    if (path === '/entry.js') return new Response(Bun.file(`${output}/entry.js`));
    if (path === '/call-encryption.worker.js')
      return new Response(Bun.file('packages/frontend/public/call-encryption.worker.js'));
    return new Response(null, { status: 404 });
  },
});
let sfu: ReturnType<typeof Bun.spawn> | undefined;
async function run(name: string) {
  const proc = Bun.spawn(['node', `scripts/call-media-browser/${name}.mjs`], {
    env: { ...process.env, ALLO_CALL_TEST_ORIGIN: server.url.href },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const result = await new Response(proc.stdout).text();
  console.log(result.trim());
  await writeFile(`${output}/${name}-result.json`, result);
  if ((await proc.exited) !== 0) throw new Error(`${name} failed`);
}
try {
  await run('verify');
  if (process.env.ALLO_CALL_TEST_TURN_URL) await run('relay');
  const binary = process.env.ALLO_CALL_LIVEKIT_BINARY;
  if (process.env.ALLO_CALL_LIVEKIT_URL) {
    await run('group');
  } else if (binary) {
    const config = `${output}/livekit.yaml`;
    await writeFile(
      config,
      'port: 55912\nbind_addresses: [127.0.0.1]\nrtc:\n  tcp_port: 55913\n  udp_port: 55914\n  use_external_ip: false\n  node_ip: 127.0.0.1\nkeys:\n  devkey: development-only-video-verification-secret\n',
    );
    sfu = Bun.spawn([binary, '--config', config], {
      stdout: Bun.file(`${output}/livekit.log`),
      stderr: Bun.file(`${output}/livekit-errors.log`),
    });
    let ready = false;
    for (let i = 0; i < 50; i++) {
      if (sfu.exitCode !== null) throw new Error('test LiveKit exited before startup');
      try {
        await fetch('http://127.0.0.1:55912');
        ready = true;
        break;
      } catch {
        await Bun.sleep(100);
      }
    }
    if (!ready) throw new Error('test LiveKit did not start');
    await run('group');
  } else console.log('SFU skipped: set ALLO_CALL_LIVEKIT_BINARY to a local LiveKit binary.');
} finally {
  server.stop(true);
  sfu?.kill();
}
