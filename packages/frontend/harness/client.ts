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
    await ana.sync.flush();

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
