/**
 * RELOADING THE PAGE MUST NOT ENROL A SECOND DEVICE.
 *
 * The journey a person reported, run against the real web adapters and a real
 * `@allo/core` client: sign in, send a message, reload. The reload is modelled
 * the way a browser does it — every object in the page is gone, and the two
 * IndexedDB databases are not — so nothing survives except what was actually
 * persisted.
 *
 * What is asserted is the thing that went wrong: the second run must resume
 * the SAME instance, still `active`, and the server must have been asked to
 * register exactly once. A second registration is what puts a device on the
 * "approve this device" screen, and on an account whose only other device is
 * the one that just lost its key, that screen has no way out.
 */
import { createAlloClient, testing, type AlloClient } from '@allo/core';
import { IndexedDbSecrets, type SecretsIdb, type SecretsIdbRequest, type SecretsIdbStore, type SecretsIdbTransaction } from '@/lib/allo/secrets.web';
import { IndexedDbStorage, type KvIdb, type KvIdbRequest, type KvIdbStore, type KvIdbTransaction } from '@/lib/allo/storage.web';

const { createFakeAlloServer, FakeSession } = testing;

/**
 * One in-memory IndexedDB, shared by both adapters' shapes.
 *
 * It outlives the "page", which is the whole point: a reload throws away the
 * adapters and the client and keeps the database.
 */
class FakeDatabase {
  rows = new Map<string, Uint8Array>();

  transaction(): FakeTransaction {
    return new FakeTransaction(this);
  }
}

class FakeRequest<T> implements KvIdbRequest<T>, SecretsIdbRequest<T> {
  result!: T;
  error?: unknown;
  onsuccess: ((event: never) => unknown) | null = null;
  onerror: ((event: never) => unknown) | null = null;
}

class FakeTransaction implements KvIdbTransaction, SecretsIdbTransaction {
  oncomplete: ((event: never) => unknown) | null = null;
  onerror: ((event: never) => unknown) | null = null;
  onabort: ((event: never) => unknown) | null = null;
  error?: unknown;
  private pending = 0;
  private issued = false;

  constructor(private readonly db: FakeDatabase) {
    // The commit lands after the task that issued the requests finishes, which
    // is what makes "resolved" and "durable" different moments in a browser.
    queueMicrotask(() => {
      this.issued = true;
      this.settle();
    });
  }

  private settle(): void {
    if (this.issued && this.pending === 0) queueMicrotask(() => this.oncomplete?.(undefined as never));
  }

  private run<T>(apply: () => T): FakeRequest<T> {
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      request.result = apply();
      this.pending -= 1;
      request.onsuccess?.(undefined as never);
      this.settle();
    });
    return request;
  }

  objectStore(): KvIdbStore & SecretsIdbStore {
    const { db } = this;
    return {
      get: (key: string) => this.run(() => db.rows.get(key)),
      put: (value: unknown, key: string) =>
        this.run(() => {
          db.rows.set(key, value as Uint8Array);
          return undefined;
        }),
      delete: (key: string) =>
        this.run(() => {
          db.rows.delete(key);
          return undefined;
        }),
      getAllKeys: (range: unknown) =>
        this.run(() => {
          const { lower, upper } = range as { lower: string; upper: string };
          return [...db.rows.keys()].filter((key) => key >= lower && key < upper).sort();
        }),
    };
  }
}

const range = (lower: string, upper: string) => ({ lower, upper });

/** One "page load": fresh adapters and a fresh client over the databases that survived. */
async function load(
  server: ReturnType<typeof createFakeAlloServer>,
  store: FakeDatabase,
  secretStore: FakeDatabase,
  accountId: string,
): Promise<AlloClient> {
  const client = createAlloClient({
    baseUrl: server.baseUrl,
    appId: 'allo',
    platform: 'web',
    displayName: 'Chrome',
    session: FakeSession.for(accountId),
    storage: new IndexedDbStorage(store as unknown as KvIdb, range),
    secrets: new IndexedDbSecrets(secretStore as unknown as SecretsIdb),
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
  });
  await client.start();
  return client;
}

const ACCOUNT = '6700000000000000000000a1';
const OTHER = '6700000000000000000000a2';

describe('reloading the page', () => {
  it('resumes the same device rather than enrolling a second one', async () => {
    const server = createFakeAlloServer();
    const store = new FakeDatabase();
    const secrets = new FakeDatabase();

    const first = await load(server, store, secrets, ACCOUNT);
    expect(first.instance.state()).toBe('active');
    const enrolled = first.instanceId;

    // Use it the way the report did: a conversation and a couple of messages.
    const conversation = await first.conversations.createDirect(OTHER);
    await first.messages.send(conversation.id, 'hola');
    await first.messages.send(conversation.id, 'que tal');
    await first.sync.flush();

    // The page goes away. The databases do not.
    await first.stop();

    const second = await load(server, store, secrets, ACCOUNT);
    expect(second.instance.state()).toBe('active');
    expect(second.instanceId).toBe(enrolled);

    // And the server was asked to enrol exactly once, which is the fact behind
    // the screen: a second registration on an account that already has an
    // active device comes back `pending`.
    const registrations = server.requestLog.filter((entry) => entry.method === 'POST' && entry.path === '/v1/instances');
    expect(registrations).toHaveLength(1);

    // The messages are still there, which is what "the same device" means.
    expect(second.messages.timeline(conversation.id).length).toBeGreaterThanOrEqual(2);
    await second.stop();
  }, 30_000);

  it('enrols again only when the signing key is genuinely gone, and says which half it lost', async () => {
    const server = createFakeAlloServer();
    const store = new FakeDatabase();
    const secrets = new FakeDatabase();

    const first = await load(server, store, secrets, ACCOUNT);
    const enrolled = first.instanceId;
    await first.stop();

    // Clearing the secret store alone is what a browser evicting one database
    // and not the other looks like.
    secrets.rows.clear();

    const second = await load(server, store, secrets, ACCOUNT);
    expect(second.instanceId).not.toBe(enrolled);
    // The account already has an active device, so the new one waits.
    expect(second.instance.state()).toBe('pending-approval');
    await second.stop();
  }, 30_000);
});
