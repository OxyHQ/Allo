/* LOCAL HARNESS ONLY — stands in for lib/allo/client.ts when ALLO_HARNESS=1.
   One in-memory fake server, two clients (me and Ana), a DM and a group with a
   few messages, so every chat screen can be looked at without a real account. */
import type { AlloClient } from '@allo/core';

/* The SDK is required lazily: this module is evaluated while `@allo/core` is
   still initialising, so a static namespace import binds an empty object. */
// eslint-disable-next-line @typescript-eslint/no-require-imports
const sdk = () => require('@allo/core') as typeof import('@allo/core');

export const APP_ID = 'allo';

type Server = ReturnType<typeof import('@allo/core').testing.createFakeAlloServer>;
let server: Server | null = null;

function build(server: Server, accountId: string, displayName: string): AlloClient {
  const { createAlloClient, testing } = sdk();
  const { FakeSession, MemorySecrets, MemoryStorage } = testing;
  return createAlloClient({
    baseUrl: server.baseUrl,
    appId: APP_ID,
    platform: 'web',
    displayName,
    session: FakeSession.for(accountId),
    storage: new MemoryStorage(),
    secrets: new MemorySecrets(),
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 5_000,
  });
}

/** A picture the browser can actually decode, drawn on a canvas rather than shipped as bytes. */
async function picture(width: number, height: number): Promise<Uint8Array> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (context) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#1f7a4d');
    gradient.addColorStop(1, '#8fd6b4');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
    context.fillStyle = 'rgba(255,255,255,0.75)';
    context.fillRect(width * 0.12, height * 0.55, width * 0.4, height * 0.3);
  }
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/png'));
  return new Uint8Array(await (blob ?? new Blob()).arrayBuffer());
}

/** A few seconds of silence: enough for a voice note to have a length and a player. */
function silence(seconds: number): Uint8Array {
  const rate = 8000;
  const samples = rate * seconds;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const ascii = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + samples, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate, true);
  view.setUint16(32, 1, true);
  view.setUint16(34, 8, true);
  ascii(36, 'data');
  view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  return bytes;
}

let seeded = false;

export async function createAppAlloClient(): Promise<AlloClient> {
  const { testing } = sdk();
  const { until } = testing;
  server ??= testing.createFakeAlloServer();
  const running = server;
  const me = build(running, '6700000000000000000000a1', 'This browser');
  if (seeded) return me;
  seeded = true;
  void (async () => {
    // `AlloRoot` starts this one; the harness only waits for it.
    await until(() => me.instance.state() === 'active', 30_000, 25);

    const ana = build(running, '6700000000000000000000a2', 'Ana iPhone');
    const teodor = build(running, '6700000000000000000000a3', 'Teodor Android');
    await ana.start();
    await teodor.start();

    const dm = await me.conversations.createDirect('6700000000000000000000a2');
    await until(() => ana.conversations.get(dm.id)?.joined === true, 30_000, 25);
    await ana.messages.send(dm.id, 'Morning! The loft viewing is still on for Thursday?');
    await ana.sync.flush();
    await me.messages.send(dm.id, "It is — eight o'clock, the place by the canal.");
    await ana.messages.send(dm.id, "Perfect. I'll bring the floorplan Teodor sent over.");
    await ana.sync.flush();
    await me.messages.send(dm.id, 'Bring the measuring tape too, the balcony looked smaller than the photos.');
    await ana.messages.send(dm.id, 'Already in the bag.');
    await ana.messages.send(dm.id, 'The listing is here: https://canal-lofts.example/viewing');
    await ana.sync.flush();

    await ana.media.upload(dm.id, await picture(1200, 800), {
      kind: 'image',
      mime: 'image/png',
      filename: 'balcony.png',
      width: 1200,
      height: 800,
      caption: 'The balcony, from the kitchen door',
      thumbnail: { bytes: await picture(320, 214), mime: 'image/png', width: 320, height: 214 },
    });
    await ana.media.upload(dm.id, new TextEncoder().encode('Floorplan, 68 m2, balcony south.'), {
      kind: 'file',
      mime: 'text/plain',
      filename: 'floorplan.txt',
    });
    await me.media.upload(dm.id, silence(4), {
      kind: 'voice',
      mime: 'audio/wav',
      filename: 'voice.wav',
      durationMs: 4000,
    });
    await ana.sync.flush();
    await me.sync.now();

    const group = await me.conversations.createGroup(['6700000000000000000000a2', '6700000000000000000000a3']);
    await me.conversations.rename(group.id, 'Canal Loft Crew');
    await until(() => teodor.conversations.get(group.id)?.joined === true, 30_000, 25);
    await teodor.messages.send(group.id, 'Floorplan for the loft — the balcony is on the south side.');
    await teodor.sync.flush();
    await ana.messages.send(group.id, 'Thanks! I will print it tonight.');
    await ana.sync.flush();
    await me.sync.now();
  })();
  return me;
}
