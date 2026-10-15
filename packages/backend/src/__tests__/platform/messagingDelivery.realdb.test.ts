/** Real directory/session SDK transport and PostgreSQL provenance, with socket output observed. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test';
import { MessagingDelivery } from '../../runtime/messagingDelivery';
import { createPlatformHarness, dmBetween, type PlatformHarness } from './harness';
import { registerFixtureActor, safetyFixture } from './oxySafetyFixture';
let h: PlatformHarness;
beforeAll(async () => {
  h = await createPlatformHarness();
}, 180000);
afterAll(async () => {
  await h.drop();
});
beforeEach(() => safetyFixture.reset());
async function until(check: () => boolean) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('socket authority did not settle');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
it('batches live proofs for 103 sockets and emits nothing for mismatched, revoked or unavailable authority', async () => {
  const { a, b, conversationId } = await dmBetween(h.app);
  safetyFixture.supervised.add(a.accountId);
  safetyFixture.contacts.add(safetyFixture.pair(a.accountId, b.accountId));
  const emitted: string[] = [];
  const disconnected: string[] = [];
  const sockets = Array.from({ length: 103 }, (_, i) => ({
    id: `socket-${i}`,
    handshake: { auth: { token: registerFixtureActor(a.accountId) } },
    data: { instance: { id: a.id, accountId: a.accountId } },
    emit: () => {
      emitted.push(`socket-${i}`);
    },
    disconnect: () => {
      disconnected.push(`socket-${i}`);
    },
  }));
  const delivery = new MessagingDelivery(async () => sockets);
  const nudge = () => delivery.enqueue('sync.nudge', { conversationId }, [`instance:${a.id}`]);
  safetyFixture.calls = [];
  nudge();
  await until(() => emitted.length === 103);
  const proofs = safetyFixture.calls.filter((call) => call.path.endsWith('/messaging-sessions'));
  expect(proofs).toHaveLength(2);
  expect(proofs.map((call) => (call.body as { items: unknown[] }).items.length)).toEqual([100, 3]);
  expect(disconnected).toEqual([]);
  emitted.length = 0;
  sockets[0].handshake.auth.token = registerFixtureActor(b.accountId);
  nudge();
  await until(() => emitted.length + disconnected.length === 103);
  expect(disconnected).toEqual(['socket-0']);
  expect(emitted).not.toContain('socket-0');
  emitted.length = 0;
  disconnected.length = 0;
  safetyFixture.revoked.add(a.accountId);
  nudge();
  await until(() => disconnected.length === 103);
  expect(emitted).toEqual([]);
  disconnected.length = 0;
  safetyFixture.revoked.clear();
  safetyFixture.unavailable = true;
  nudge();
  await until(() => disconnected.length === 103);
  expect(emitted).toEqual([]);
});
