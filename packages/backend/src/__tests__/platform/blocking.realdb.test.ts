import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, sql } from 'drizzle-orm';
import { blockUser, unblockUser, lockContactPairs } from '../../db/social/blockRepository';
import { appendClientEvent } from '../../db/platform/eventRepository';
import { listMembers, listLeaves } from '../../db/platform/conversationRepository';
import { conversationEvents, conversations } from '../../db/schema';
import { relayTyping } from '../../runtime/socket';
import { registerFixtureActor } from './oxySafetyFixture';
import {
  accountId,
  base64,
  createPlatformHarness,
  dmBetween,
  groupOfThree,
  mlsGroupId,
  TestInstance,
  type PlatformHarness,
} from './harness';

let h: PlatformHarness;
beforeAll(async () => {
  h = await createPlatformHarness();
}, 180_000);
afterAll(async () => {
  await h?.drop();
});
let counter = 0;
const key = () => `block-test-${++counter}`;
const message = () => ({
  idempotencyKey: key(),
  kind: 'app_message' as const,
  epoch: 1,
  payload: base64('opaque encrypted content'),
});
const createBody = (kind: 'dm' | 'group', members: string[]) => ({
  kind,
  memberAccountIds: members,
  mlsGroupId: mlsGroupId(),
  idempotencyKey: key(),
});
const post = (sender: TestInstance, id: string, body = message()) =>
  sender.signed('post', `/v1/conversations/${id}/events`, body);

async function waitForLockWaiter() {
  for (let attempt = 0; attempt < 100; attempt++) {
    const rows = await h.db.execute(sql`select count(*)::int as n from pg_locks
      where locktype = 'advisory' and not granted and database =
      (select oid from pg_database where datname = current_database())`);
    if (Number(rows[0]?.n) > 0) return;
    await Bun.sleep(10);
  }
  throw new Error('Expected a contact operation waiting for its transaction lock');
}

describe('blocks govern new contact, preserving history and shared groups', () => {
  it('refuses fresh DMs and group invitations in both directions without storing anything', async () => {
    const a = await TestInstance.register(h.app, accountId());
    const b = await TestInstance.register(h.app, accountId());
    await blockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    for (const [sender, other] of [
      [a, b],
      [b, a],
    ]) {
      for (const kind of ['dm', 'group'] as const) {
        const body = createBody(kind, [other.accountId]);
        const response = await sender.signed('post', '/v1/conversations', body);
        expect(response.status).toBe(403);
        expect(response.body.error.code).toBe('forbidden');
        expect(
          await h.db
            .select()
            .from(conversations)
            .where(eq(conversations.mlsGroupId, body.mlsGroupId)),
        ).toHaveLength(0);
      }
    }
    await unblockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    expect(
      (await a.signed('post', '/v1/conversations', createBody('dm', [b.accountId]))).status,
    ).toBe(201);
  });

  it('refuses new direct content in both directions; retains old events, sync and replay', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const prior = message();
    const sent = await post(a, conversationId, prior);
    expect(sent.status).toBe(200);
    const before = await h.db
      .select()
      .from(conversationEvents)
      .where(eq(conversationEvents.conversationId, conversationId));
    await blockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    h.realtime.reset();
    for (const sender of [a, b]) {
      expect((await post(sender, conversationId)).status).toBe(403);
      const history = await sender.signed('get', `/v1/conversations/${conversationId}/events`);
      expect(history.status).toBe(200);
      expect(
        history.body.events.some((event: { id: string }) => event.id === sent.body.event.id),
      ).toBe(true);
      expect((await sender.signed('get', `/v1/conversations/${conversationId}`)).status).toBe(200);
    }
    expect((await post(a, conversationId, prior)).body.event).toEqual(sent.body.event);
    expect(h.realtime.nudges).toHaveLength(0);
    expect(
      await h.db
        .select()
        .from(conversationEvents)
        .where(eq(conversationEvents.conversationId, conversationId)),
    ).toEqual(before);
    const sync = await b.signed('get', '/v1/sync');
    expect(
      sync.body.deliveries.some(
        (delivery: { event: { id: string } }) => delivery.event.id === sent.body.event.id,
      ),
    ).toBe(true);
    await unblockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    expect((await post(b, conversationId)).status).toBe(200);
  });

  it('keeps shared-group membership, leaves and new messages in both directions', async () => {
    const { a, b, c, conversationId } = await groupOfThree(h.app);
    const members = await listMembers(conversationId, h.db);
    const leaves = await listLeaves(conversationId, h.db);
    await blockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    for (const sender of [a, b, c]) expect((await post(sender, conversationId)).status).toBe(200);
    expect(await listMembers(conversationId, h.db)).toEqual(members);
    expect(await listLeaves(conversationId, h.db)).toEqual(leaves);
  });

  it('refuses invitations via MLS additions but permits existing-member device maintenance', async () => {
    const { a, b, conversationId } = await groupOfThree(h.app);
    const stranger = await TestInstance.register(h.app, accountId());
    await blockUser(h.db, { userId: stranger.accountId, blockedId: a.accountId });
    const add = (instance: TestInstance) =>
      a.signed('post', `/v1/conversations/${conversationId}/events`, {
        idempotencyKey: key(),
        kind: 'mls_commit',
        epoch: 1,
        payload: base64('commit'),
        commit: {
          newEpoch: 2,
          groupInfo: base64('gi-2'),
          addedLeaves: [{ instanceId: instance.id, accountId: instance.accountId }],
          removedLeaves: [],
          welcome: { payload: base64('welcome'), recipients: [instance.id] },
        },
      });
    expect((await add(stranger)).status).toBe(403);
    expect(
      (await listMembers(conversationId, h.db)).some((m) => m.accountId === stranger.accountId),
    ).toBe(false);
    const b2 = await TestInstance.register(h.app, b.accountId);
    await b.approve(b2);
    await blockUser(h.db, { userId: a.accountId, blockedId: b.accountId });
    expect((await add(b2)).status).toBe(200);
  });

  it('cuts DM typing but preserves shared-group typing', async () => {
    for (const create of [dmBetween, groupOfThree]) {
      const { a, b, conversationId } = await create(h.app);
      const frame = { conversationId, ciphertext: base64('typing') };
      const sender = { id: a.id, accountId: a.accountId, appId: 'allo', status: 'active' as const };
      await relayTyping(sender, frame, h.realtime, registerFixtureActor(a.accountId));
      await blockUser(h.db, { userId: b.accountId, blockedId: a.accountId });
      h.realtime.reset();
      if (create === dmBetween) {
        await expect(
          relayTyping(sender, frame, h.realtime, registerFixtureActor(a.accountId)),
        ).rejects.toMatchObject({
          code: 'forbidden',
        });
        expect(h.realtime.typings).toHaveLength(0);
      } else {
        await relayTyping(sender, frame, h.realtime, registerFixtureActor(a.accountId));
        expect(h.realtime.typings).toHaveLength(1);
      }
    }
  });

  it('serializes a block behind an in-flight send, then refuses every later send', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const gate = Promise.withResolvers<void>();
    const appended = Promise.withResolvers<void>();
    const sending = h.db.transaction(async (tx) => {
      await appendClientEvent(
        {
          conversationId,
          sender: { instanceId: a.id, accountId: a.accountId },
          request: message(),
        },
        tx,
      );
      appended.resolve();
      await gate.promise;
    });
    await appended.promise;
    const blocking = blockUser(h.db, { userId: b.accountId, blockedId: a.accountId });
    try {
      await waitForLockWaiter();
    } finally {
      gate.resolve();
    }
    await sending;
    expect(await blocking).toBe(true);
    expect((await post(a, conversationId)).status).toBe(403);
  });

  it('a send waiting on a concurrent block sees the committed block', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const gate = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    const blocking = h.db.transaction(async (tx) => {
      await lockContactPairs(tx, b.accountId, [a.accountId]);
      held.resolve();
      await gate.promise;
      // The public repository takes the same pair lock. This nested savepoint
      // keeps its committed row private until the outer transaction commits.
      await blockUser(tx, { userId: b.accountId, blockedId: a.accountId });
    });
    await held.promise;
    const sending = post(a, conversationId).then((response) => response);
    try {
      await waitForLockWaiter();
    } finally {
      gate.resolve();
    }
    await blocking;
    expect((await sending).status).toBe(403);
  });
});
