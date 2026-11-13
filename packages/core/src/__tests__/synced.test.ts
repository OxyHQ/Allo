/**
 * `client.sync.synced()` says whether a sync has completed since `start()`.
 *
 * `state()` cannot: the engine returns to `idle` after a sync without a live
 * socket. Allo's conversation list read "no conversations yet" for seconds on
 * a cold start (Pixel 8a) because an empty list before the first sync looked
 * the same as an empty account.
 */
import { describe, expect, it } from 'bun:test';
import { fakeServer, makeClient, stopAll } from './e2eHelpers';

describe('sync.synced()', () => {
  it('is false before start and true once a sync has completed', async () => {
    const server = fakeServer();
    const alice = await makeClient(server, 'acc-alice-01', 'Alice', 'web', undefined, false);
    expect(alice.client.sync.synced()).toBe(false);
    await alice.client.start();
    await alice.client.sync.now();
    expect(alice.client.sync.synced()).toBe(true);
    await stopAll(alice);
  });

  it('notifies `sync` subscribers when it turns true', async () => {
    const server = fakeServer();
    const alice = await makeClient(server, 'acc-alice-01', 'Alice', 'web', undefined, false);
    const seen: boolean[] = [];
    const off = alice.client.subscribe('sync', () => seen.push(alice.client.sync.synced()));
    await alice.client.start();
    await alice.client.sync.now();
    expect(seen).toContain(true);
    off();
    await stopAll(alice);
  });
});
