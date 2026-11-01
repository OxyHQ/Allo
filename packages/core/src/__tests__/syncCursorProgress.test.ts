import { describe, expect, it } from 'bun:test';
import { decodeCursor, encodeCursor } from '@allo/shared-types';
import { fakeServer, makeClient, stopAll } from './e2eHelpers';

type Page = { deliveries: unknown[]; nextCursor: string; hasMore: boolean };

/** Synthetic control delivery for exercising the real dispatcher and storage. */
function delivery(cursor: string, id: string, seq = 1) {
  const event = {
    id,
    conversationId: 'conversation-0001',
    seq,
    kind: 'control',
    epoch: 0,
    senderAccountId: 'allo:server',
    senderInstanceId: null,
    payload: Buffer.from(JSON.stringify({ t: 'conversation_created' })).toString('base64'),
    blobIds: [],
    createdAt: '2026-11-01T00:00:00.000Z',
  };
  return { cursor, conversationId: event.conversationId, event };
}

describe('sync cursor progress', () => {
  async function harness() {
    const server = fakeServer();
    let response: ((cursor: string, index: number) => Page) | undefined;
    const requested: string[] = [];
    const acknowledged: string[] = [];
    const transport = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (response && url.pathname === '/v1/sync') {
        const cursor = url.searchParams.get('cursor') ?? '';
        requested.push(cursor);
        if (requested.length > 3) throw new Error('test stopped repeated requests');
        return Response.json(response(cursor, requested.length - 1));
      }
      if (response && url.pathname === '/v1/sync/ack') {
        acknowledged.push((JSON.parse(String(init?.body)) as { cursor: string }).cursor);
      }
      return server.fetch(input, init);
    }) as typeof fetch;
    const alice = await makeClient(server, 'acc-alice-01', 'Alice', 'web', undefined, true, {
      transport: { fetch: transport, socketFactory: server.socketFactory },
    });
    await alice.client.sync.now();
    return {
      alice,
      requested,
      acknowledged,
      respond(fn: (cursor: string, index: number) => Page) {
        response = fn;
      },
      reset(fn: (cursor: string, index: number) => Page) {
        requested.length = 0;
        response = fn;
      },
      async close() {
        response = undefined;
        await stopAll(alice);
      },
    };
  }

  it('fails before retrying or acknowledging a page that says more without advancing, then recovers', async () => {
    const h = await harness();
    try {
      h.respond((cursor) => ({ deliveries: [], nextCursor: cursor, hasMore: true }));
      const writes = h.alice.storage.writes;
      await expect(h.alice.client.sync.now()).rejects.toMatchObject({ code: 'invalid_state' });
      expect(h.requested).toHaveLength(1);
      expect(h.acknowledged).toEqual([]);
      expect(h.alice.storage.writes).toBe(writes);
      expect(h.alice.client.sync.state()).toBe('error');
      const prior = h.requested[0];
      h.reset((cursor) => ({ deliveries: [], nextCursor: cursor, hasMore: false }));
      await h.alice.client.sync.now();
      expect(h.requested).toEqual([prior]);
      expect(h.acknowledged).toEqual([]);
    } finally {
      await h.close();
    }
  });

  it('accepts an empty filtered page that advances and a terminal empty page that does not', async () => {
    const h = await harness();
    try {
      h.respond((cursor, index) => ({
        deliveries: [],
        nextCursor: index === 0 ? encodeCursor(decodeCursor(cursor) + 1n) : cursor,
        hasMore: index === 0,
      }));
      await h.alice.client.sync.now();
      expect(h.requested).toHaveLength(2);
      expect(decodeCursor(h.requested[1])).toBe(decodeCursor(h.requested[0]) + 1n);
      expect(h.acknowledged).toEqual([]);
      const advanced = h.requested[1];
      h.reset((cursor) => ({ deliveries: [], nextCursor: cursor, hasMore: false }));
      await h.alice.client.sync.now();
      expect(h.requested).toEqual([advanced]);
    } finally {
      await h.close();
    }
  });

  it('persists a new cursor from a terminal filtered page without acknowledging deliveries', async () => {
    const h = await harness();
    try {
      h.respond((cursor) => ({
        deliveries: [],
        nextCursor: encodeCursor(decodeCursor(cursor) + 1n),
        hasMore: false,
      }));
      await h.alice.client.sync.now();
      expect(h.requested).toHaveLength(1);
      const advanced = encodeCursor(decodeCursor(h.requested[0]) + 1n);
      expect(h.acknowledged).toEqual([]);
      h.reset((cursor) => ({ deliveries: [], nextCursor: cursor, hasMore: false }));
      await h.alice.client.sync.now();
      expect(h.requested).toEqual([advanced]);
    } finally {
      await h.close();
    }
  });

  it('rejects a repeated continuation before dispatching or acknowledging its deliveries', async () => {
    const h = await harness();
    try {
      h.respond((cursor) => ({
        deliveries: [delivery(encodeCursor(decodeCursor(cursor) + 1n), 'event-0001')],
        nextCursor: cursor,
        hasMore: true,
      }));
      const writes = h.alice.storage.writes;
      await expect(h.alice.client.sync.now()).rejects.toMatchObject({ code: 'invalid_state' });
      expect(h.requested).toHaveLength(1);
      expect(h.acknowledged).toEqual([]);
      expect(h.alice.storage.writes).toBe(writes);
      expect([...h.alice.storage.map.keys()].some((key) => key.includes('event-0001'))).toBe(false);
      const prior = h.requested[0];
      h.reset((cursor) => ({
        deliveries: [delivery(encodeCursor(decodeCursor(cursor) + 1n), 'event-0001')],
        nextCursor: encodeCursor(decodeCursor(cursor) + 1n),
        hasMore: false,
      }));
      await h.alice.client.sync.now();
      expect(h.requested).toEqual([prior]);
      expect(h.acknowledged).toEqual([encodeCursor(decodeCursor(prior) + 1n)]);
      expect(h.alice.storage.writes).toBeGreaterThan(writes);
      expect([...h.alice.storage.map.keys()].some((key) => key.includes('event-0001'))).toBe(true);
    } finally {
      await h.close();
    }
  });

  it('rejects a cycle to the initial cursor and retries from the last committed page', async () => {
    const h = await harness();
    try {
      let writesBeforeBadPage = -1;
      h.respond((cursor, index) => {
        if (index === 0) {
          const next = encodeCursor(decodeCursor(cursor) + 1n);
          return { deliveries: [delivery(next, 'event-0001')], nextCursor: next, hasMore: true };
        }
        writesBeforeBadPage = h.alice.storage.writes;
        return {
          deliveries: [delivery(encodeCursor(decodeCursor(cursor) + 1n), 'event-0002', 2)],
          nextCursor: h.requested[0],
          hasMore: true,
        };
      });
      await expect(h.alice.client.sync.now()).rejects.toMatchObject({ code: 'invalid_state' });
      expect(h.requested).toHaveLength(2);
      expect(h.acknowledged).toEqual([h.requested[1]]);
      expect(h.alice.storage.writes).toBe(writesBeforeBadPage);
      expect([...h.alice.storage.map.keys()].some((key) => key.includes('event-0001'))).toBe(true);
      expect([...h.alice.storage.map.keys()].some((key) => key.includes('event-0002'))).toBe(false);
      const committed = h.requested[1];
      h.reset((cursor) => ({
        deliveries: [delivery(encodeCursor(decodeCursor(cursor) + 1n), 'event-0002', 2)],
        nextCursor: encodeCursor(decodeCursor(cursor) + 1n),
        hasMore: false,
      }));
      await h.alice.client.sync.now();
      expect(h.requested).toEqual([committed]);
      expect(h.acknowledged).toEqual([committed, encodeCursor(decodeCursor(committed) + 1n)]);
      expect(h.alice.storage.writes).toBeGreaterThan(writesBeforeBadPage);
      expect([...h.alice.storage.map.keys()].some((key) => key.includes('event-0002'))).toBe(true);
    } finally {
      await h.close();
    }
  });
});
