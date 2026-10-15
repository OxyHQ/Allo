/** Real encrypted clients, database, HTTP and shared Oxy SDK authority transport. */
import { afterAll, beforeAll, beforeEach, expect, it } from 'bun:test';
import { Harness, stopAll, waitForText, waitJoined, waitFor, type TestClient } from './harness';
import { safetyFixture } from '../platform/oxySafetyFixture';
const h = new Harness();
const clients: TestClient[] = [];
beforeAll(() => h.boot(), 180000);
beforeEach(() => safetyFixture.reset());
afterAll(async () => {
  await stopAll(...clients);
  await h.shutdown();
});
it('withholds cached ciphertext projections after contact revocation, outage and session restart without erasing keys', async () => {
  const aId = h.account('child');
  const bId = h.account('contact');
  const a = await h.makeClient(aId, 'Child', 'web');
  const b = await h.makeClient(bId, 'Contact', 'web');
  clients.push(a, b);
  const conversation = await a.client.conversations.createDirect(bId);
  await b.client.conversations.refresh();
  await b.client.sync.now();
  await waitJoined(b, conversation.id);
  await b.client.messages.send(conversation.id, 'Private historical message');
  await waitForText(a, conversation.id, 'Private historical message');
  await a.client.stop();
  safetyFixture.supervised.add(aId);
  safetyFixture.contacts.add(safetyFixture.pair(aId, bId));
  const supervised = await h.makeClient(aId, 'Child', 'web', {
    storage: a.storage,
    secrets: a.secrets,
    requireLiveConversationAccess: true,
  });
  clients.push(supervised);
  await supervised.client.sync.now();
  await waitForText(supervised, conversation.id, 'Private historical message');
  expect(supervised.client.conversations.get(conversation.id)?.access).toBe('allowed');
  const epoch = supervised.client.conversations.get(conversation.id)?.epoch;
  safetyFixture.contacts.clear();
  await supervised.client.conversations.refresh();
  expect(supervised.client.conversations.get(conversation.id)).toMatchObject({
    access: 'blocked',
    title: null,
    memberAccountIds: [],
    unreadCount: 0,
  });
  expect(supervised.client.conversations.get(conversation.id)?.lastMessage).toBeUndefined();
  expect(supervised.client.messages.timeline(conversation.id)).toEqual([]);
  expect(supervised.client.messages.timeline(conversation.id)).toBe(
    supervised.client.messages.timeline(conversation.id),
  );
  await expect(supervised.client.messages.send(conversation.id, 'blocked draft')).rejects.toThrow(
    'access is unavailable',
  );
  await supervised.client.sync.now();
  expect(supervised.client.messages.timeline(conversation.id)).toEqual([]);
  safetyFixture.contacts.add(safetyFixture.pair(aId, bId));
  await supervised.client.sync.now();
  expect(supervised.client.conversations.get(conversation.id)?.epoch).toBe(epoch);
  await waitForText(supervised, conversation.id, 'Private historical message');
  safetyFixture.unavailable = true;
  await expect(supervised.client.conversations.refresh()).rejects.toThrow();
  expect(supervised.client.conversations.get(conversation.id)?.access).toBe('unavailable');
  expect(supervised.client.messages.timeline(conversation.id)).toEqual([]);
  safetyFixture.unavailable = false;
  await supervised.client.stop();
  const restored = await h.makeClient(aId, 'Child', 'web', {
    storage: a.storage,
    secrets: a.secrets,
    requireLiveConversationAccess: true,
  });
  clients.push(restored);
  await restored.client.sync.now();
  await waitForText(restored, conversation.id, 'Private historical message');
  expect(restored.client.instanceId).toBe(a.client.instanceId);
}, 60000);

it('advances past a whole withheld sync page and recovers every MLS commit after reauthorization and restart', async () => {
  const aId = h.account('paged-child');
  const bId = h.account('historical-contact');
  const cId = h.account('allowed-contact');
  const a = await h.makeClient(aId, 'Child', 'web');
  const b = await h.makeClient(bId, 'Owner', 'web');
  const c = await h.makeClient(cId, 'Allowed', 'web');
  clients.push(a, b, c);
  const group = await b.client.conversations.createGroup([aId]);
  await a.client.conversations.refresh();
  await a.client.sync.now();
  await waitJoined(a, group.id);
  const direct = await c.client.conversations.createDirect(aId);
  await a.client.conversations.refresh();
  await a.client.sync.now();
  await waitJoined(a, direct.id);
  const originalEpoch = a.client.conversations.get(group.id)!.epoch;
  await a.client.stop();
  for (let n = 0; n < 205; n++) await b.client.messages.send(group.id, `withheld-${n}`);
  await waitFor(
    () =>
      b.client.messages
        .timeline(group.id)
        .filter((item) => ['accepted', 'delivered', 'read'].includes(item.sendState)).length >= 205,
    30000,
  );
  await b.client.conversations.addMember(group.id, cId);
  await waitFor(() => b.client.conversations.get(group.id)!.epoch > originalEpoch);
  await b.client.messages.send(group.id, 'after unseen membership commit');
  await waitFor(() =>
    b.client.messages
      .timeline(group.id)
      .some(
        (item) =>
          item.content.kind === 'text' &&
          item.content.body === 'after unseen membership commit' &&
          ['accepted', 'delivered', 'read'].includes(item.sendState),
      ),
  );
  await c.client.messages.send(direct.id, 'allowed after withheld page');
  await waitFor(() =>
    c.client.messages
      .timeline(direct.id)
      .some(
        (item) =>
          item.content.kind === 'text' &&
          item.content.body === 'allowed after withheld page' &&
          ['accepted', 'delivered', 'read'].includes(item.sendState),
      ),
  );
  safetyFixture.supervised.add(aId);
  safetyFixture.contacts.add(safetyFixture.pair(aId, cId));
  const supervised = await h.makeClient(aId, 'Child', 'web', {
    storage: a.storage,
    secrets: a.secrets,
    requireLiveConversationAccess: true,
  });
  clients.push(supervised);
  await supervised.client.sync.now();
  await waitForText(supervised, direct.id, 'allowed after withheld page');
  expect(supervised.client.messages.timeline(group.id)).toEqual([]);
  expect(supervised.client.conversations.get(group.id)?.access).toBe('blocked');
  await supervised.client.stop();
  safetyFixture.contacts.add(safetyFixture.pair(aId, bId));
  const restored = await h.makeClient(aId, 'Child', 'web', {
    storage: a.storage,
    secrets: a.secrets,
    requireLiveConversationAccess: true,
  });
  clients.push(restored);
  await restored.client.sync.now();
  await waitForText(restored, group.id, 'after unseen membership commit');
  expect(restored.client.conversations.get(group.id)?.epoch).toBe(
    b.client.conversations.get(group.id)?.epoch,
  );
  expect(
    restored.client.messages
      .timeline(group.id)
      .filter((item) => item.content.kind === 'text' && item.content.body.startsWith('withheld-')),
  ).toHaveLength(205);
  await restored.client.sync.now();
  expect(
    restored.client.messages
      .timeline(group.id)
      .filter(
        (item) =>
          item.content.kind === 'text' && item.content.body === 'after unseen membership commit',
      ),
  ).toHaveLength(1);
}, 90000);
