import { sql } from 'drizzle-orm';
import {
  transcriptParticipants,
  transcriptParticipantsQuery,
} from '../../db/platform/transcriptPolicyRepository';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import {
  createPlatformHarness,
  dmBetween,
  TestInstance,
  accountId,
  base64,
  mlsGroupId,
  type PlatformHarness,
} from './harness';
import { safetyFixture } from './oxySafetyFixture';
import { runDeliveryTick } from '../../workers/deliveryWorker';
let h: PlatformHarness;
beforeAll(async () => {
  h = await createPlatformHarness();
}, 180000);
afterAll(async () => {
  await h?.drop();
});
beforeEach(() => {
  safetyFixture.reset();
  h.realtime.reset();
});
let count = 0;
const message = (epoch = 1) => ({
  idempotencyKey: `safe-${++count}`,
  kind: 'app_message',
  epoch,
  payload: base64('opaque-ciphertext'),
});
describe('live supervised messaging authority through the real SDK and database', () => {
  it('requires approved contacts before creation and forwards only original proof plus participant metadata', async () => {
    const child = await TestInstance.register(h.app, accountId('child'));
    const other = await TestInstance.register(h.app, accountId('other'));
    safetyFixture.supervised.add(child.accountId);
    const body = {
      kind: 'dm',
      mlsGroupId: mlsGroupId(),
      memberAccountIds: [other.accountId],
      idempotencyKey: 'reviewed-create',
    };
    expect((await child.signed('post', '/v1/conversations', body)).status).toBe(403);
    safetyFixture.contacts.add(safetyFixture.pair(child.accountId, other.accountId));
    expect((await child.signed('post', '/v1/conversations', body)).status).toBe(201);
    const calls = safetyFixture.calls.filter((call) => call.path.endsWith('message-access-batch'));
    expect(calls.length).toBeGreaterThan(0);
    expect(JSON.stringify(calls)).not.toContain('opaque-ciphertext');
    expect(JSON.stringify(calls)).toContain('accessToken');
  });
  it('withholds the whole transcript, including pages after a removed sender and pending MLS deliveries', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    expect(
      (await b.signed('post', `/v1/conversations/${conversationId}/events`, message())).status,
    ).toBe(200);
    expect((await b.signed('post', `/v1/conversations/${conversationId}/leave`)).status).toBe(204);
    const own = await a.signed('post', `/v1/conversations/${conversationId}/events`, message());
    expect(own.status).toBe(200);
    safetyFixture.supervised.add(a.accountId);
    safetyFixture.contacts.add(safetyFixture.pair(a.accountId, b.accountId));
    expect(
      (await a.signed('get', `/v1/conversations/${conversationId}/events?after=0&limit=100`))
        .status,
    ).toBe(200);
    safetyFixture.contacts.clear();
    expect(
      (
        await a.signed(
          'get',
          `/v1/conversations/${conversationId}/events?after=${own.body.event.seq - 1}&limit=1`,
        )
      ).status,
    ).toBe(403);
    expect((await a.signed('get', `/v1/conversations/${conversationId}`)).status).toBe(403);
    expect((await a.signed('get', '/v1/conversations')).body.conversations).toEqual([]);
    expect((await a.signed('get', '/v1/sync?limit=100')).body.deliveries).toEqual([]);
    safetyFixture.contacts.add(safetyFixture.pair(a.accountId, b.accountId));
    expect(
      (await a.signed('get', `/v1/conversations/${conversationId}/events?after=0&limit=100`)).body
        .events.length,
    ).toBeGreaterThanOrEqual(4);
  });
  it('refuses opaque archives and revokes associated attachments with their author', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const blob = (await b.uploadBlob(Buffer.from('opaque-media'))).body.blobId;
    safetyFixture.supervised.add(a.accountId);
    safetyFixture.contacts.add(safetyFixture.pair(a.accountId, b.accountId));
    expect((await a.signed('get', `/v1/blobs/${blob}`)).status).toBe(403);
    expect((await a.signed('get', '/v1/accounts/me/backup')).status).toBe(403);
    expect((await a.signed('get', '/v1/instances/me/history-offers')).status).toBe(403);
    for (const path of ['/v1/accounts/me/BACKUP', '/v1/instances/me/HISTORY-OFFERS']) {
      expect((await a.signed('get', path)).status).toBe(403);
      expect((await b.signed('get', path)).status).toBe(200);
    }
    expect(
      (await a.signed('post', '/v1/instances/me/HISTORY-OFFERS/unknown/CONSUME', {})).status,
    ).toBe(403);
    expect((await a.signed('post', `/v1/instances/${b.id}/HISTORY-OFFERS`, {})).status).toBe(403);
    expect((await a.signed('put', '/v1/accounts/me/BACKUP', {})).status).toBe(403);
    expect((await a.signed('delete', '/v1/accounts/me/BACKUP')).status).toBe(403);
    expect(
      (
        await b.signed('post', `/v1/conversations/${conversationId}/events`, {
          ...message(),
          blobIds: [blob],
        })
      ).status,
    ).toBe(200);
    expect((await a.signed('get', `/v1/blobs/${blob}`)).status).toBe(200);
    safetyFixture.blocked.add(safetyFixture.pair(a.accountId, b.accountId));
    expect((await a.signed('get', `/v1/blobs/${blob}`)).status).toBe(403);
  });
  it('rechecks durable delivery authors and preserves pending rows during authority outages', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    await b.signed('post', `/v1/conversations/${conversationId}/events`, message());
    safetyFixture.supervised.add(a.accountId);
    safetyFixture.contacts.add(safetyFixture.pair(a.accountId, b.accountId));
    safetyFixture.unavailable = true;
    const tick = await runDeliveryTick({ db: h.db, realtime: h.realtime });
    expect(tick.claimed).toBeGreaterThan(0);
    expect(tick.deferred).toBe(tick.claimed);
    expect(tick.nudged + tick.pushed).toBe(0);
    safetyFixture.unavailable = false;
    safetyFixture.contacts.clear();
    h.realtime.reset();
    const denied = await runDeliveryTick({
      db: h.db,
      realtime: h.realtime,
      now: () => new Date(Date.now() + 60000),
    });
    expect(denied.claimed).toBeGreaterThan(0);
    expect(denied.nudged + denied.pushed).toBe(0);
    expect(h.realtime.nudges).toEqual([]);
  });
  it('uses historical membership evidence without scanning a long ciphertext transcript', async () => {
    const { a, b, conversationId } = await dmBetween(h.app);
    const other = await dmBetween(h.app);
    await b.signed('post', `/v1/conversations/${conversationId}/leave`);
    await h.db.execute(sql`
      INSERT INTO conversation_events (id,conversation_id,seq,kind,epoch,sender_account_id,sender_instance_id,payload)
      SELECT ${conversationId} || '-plan-event-' || n,${conversationId},100+n,'app_message',1,${b.accountId},${b.id},decode('00','hex')
      FROM generate_series(1,50000) n
    `);
    await h.db.execute(sql`
      INSERT INTO conversation_members (id,conversation_id,account_id,role,state)
      SELECT ${other.conversationId} || '-plan-member-' || n,${other.conversationId},'plan-account-' || n,'member','left'
      FROM generate_series(1,5000) n
    `);
    await h.db.execute(sql`ANALYZE conversation_members`);
    const evidence = await transcriptParticipants([conversationId], h.db);
    expect(evidence.get(conversationId)?.sort()).toEqual([a.accountId, b.accountId].sort());
    const orphan = await h.db.execute<{ count: number }>(sql`
      SELECT count(*)::integer AS count FROM conversation_events e
      WHERE e.conversation_id=${conversationId} AND e.sender_account_id <> 'allo:server'
      AND NOT EXISTS (SELECT 1 FROM conversation_members m WHERE m.conversation_id=e.conversation_id AND m.account_id=e.sender_account_id)
    `);
    expect(orphan[0]?.count).toBe(0);
    const plan = await h.db.execute(
      sql`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${transcriptParticipantsQuery([conversationId])}`,
    );
    const serialized = JSON.stringify(plan);
    expect(serialized).toContain('conversation_members_conversation_id_account_id_key');
    expect(serialized).not.toContain('conversation_events');
    console.info('Transcript evidence EXPLAIN (50000 events):', serialized);
  });
});
