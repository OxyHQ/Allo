/**
 * WHO IS CONNECTED RIGHT NOW — a heartbeat with a deadline, not a connection.
 *
 * A socket being open is not presence. A socket survives a phone going to
 * sleep, an ECS task being drained and a laptop closing its lid, and each of
 * those is somebody who is not there. So an instance is present while it keeps
 * saying so: `beat()` every `PRESENCE_HEARTBEAT_MS`, gone at
 * `PRESENCE_TTL_MS` after the last one. Offline is derived from the deadline
 * passing, which is true whether the client said goodbye or fell off a train.
 *
 * `drop()` exists only to make a CLEAN goodbye fast. It is an optimisation of
 * the same truth, never the source of it.
 *
 * Redis (Valkey, in production) holds it, because presence is per ACCOUNT and
 * an account's devices connect to whichever ECS task the load balancer picked.
 * One sorted set per account, member = instance id, score = the deadline in
 * epoch milliseconds: expiry is `ZREMRANGEBYSCORE 0 now`, and the key itself
 * carries a TTL so an account nobody asks about does not stay in memory.
 *
 * Without `REDIS_URL` — local development, and the test suites — the same
 * interface is served from a map in this process. That degrades exactly as
 * `socketRedisAdapter` does: correct on one task, blind across several, and
 * it says so rather than failing.
 */

import { PRESENCE_TTL_MS } from "@allo/shared-types";
import { logger } from "../utils/logger";

export interface PresenceStore {
  /** This instance of this account is here now; the deadline moves forward. */
  beat(accountId: string, instanceId: string, now?: Date): Promise<void>;
  /** A clean goodbye: forget this instance without waiting for its deadline. */
  drop(accountId: string, instanceId: string): Promise<void>;
  /** Which of these accounts have at least one instance inside its deadline. */
  onlineOf(accountIds: readonly string[], now?: Date): Promise<Set<string>>;
  close(): Promise<void>;
}

const key = (accountId: string) => `allo:presence:${accountId}`;
/** The key outlives the last deadline by a margin, so a late read still sees an empty set rather than nothing. */
const KEY_TTL_SECONDS = Math.ceil((PRESENCE_TTL_MS * 2) / 1000);

/** One task's view. Correct alone; blind to the other tasks, which is why Redis is preferred. */
export class MemoryPresenceStore implements PresenceStore {
  private readonly deadlines = new Map<string, Map<string, number>>();

  async beat(accountId: string, instanceId: string, now = new Date()): Promise<void> {
    const forAccount = this.deadlines.get(accountId) ?? new Map<string, number>();
    forAccount.set(instanceId, now.getTime() + PRESENCE_TTL_MS);
    this.deadlines.set(accountId, forAccount);
  }

  async drop(accountId: string, instanceId: string): Promise<void> {
    const forAccount = this.deadlines.get(accountId);
    if (!forAccount) return;
    forAccount.delete(instanceId);
    if (forAccount.size === 0) this.deadlines.delete(accountId);
  }

  async onlineOf(accountIds: readonly string[], now = new Date()): Promise<Set<string>> {
    const at = now.getTime();
    const online = new Set<string>();
    for (const accountId of accountIds) {
      const forAccount = this.deadlines.get(accountId);
      if (!forAccount) continue;
      for (const [instanceId, deadline] of forAccount) if (deadline <= at) forAccount.delete(instanceId);
      if (forAccount.size > 0) online.add(accountId);
      else this.deadlines.delete(accountId);
    }
    return online;
  }

  async close(): Promise<void> {
    this.deadlines.clear();
  }
}

/** What this module uses of `redis`, so the import can stay dynamic and optional. */
interface RedisLike {
  isOpen: boolean;
  isReady: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  on(event: string, cb: (e: unknown) => void): unknown;
  zAdd(key: string, member: { score: number; value: string }): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  zRemRangeByScore(key: string, min: number, max: number): Promise<unknown>;
  zCard(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  multi(): RedisMulti;
}
interface RedisMulti {
  zAdd(key: string, member: { score: number; value: string }): RedisMulti;
  zRem(key: string, member: string): RedisMulti;
  zRemRangeByScore(key: string, min: number, max: number): RedisMulti;
  zCard(key: string): RedisMulti;
  expire(key: string, seconds: number): RedisMulti;
  exec(): Promise<unknown[]>;
}

export class RedisPresenceStore implements PresenceStore {
  constructor(private readonly redis: RedisLike) {}

  async beat(accountId: string, instanceId: string, now = new Date()): Promise<void> {
    await this.redis
      .multi()
      .zAdd(key(accountId), { score: now.getTime() + PRESENCE_TTL_MS, value: instanceId })
      .expire(key(accountId), KEY_TTL_SECONDS)
      .exec();
  }

  async drop(accountId: string, instanceId: string): Promise<void> {
    await this.redis.zRem(key(accountId), instanceId);
  }

  /**
   * One round trip for the whole watch set: per account, drop the expired
   * members and count what is left. A `ZCARD` of 0 is an offline account and
   * an account nobody has ever seen, which are the same answer here.
   */
  async onlineOf(accountIds: readonly string[], now = new Date()): Promise<Set<string>> {
    if (accountIds.length === 0) return new Set();
    const at = now.getTime();
    const pipeline = this.redis.multi();
    for (const accountId of accountIds) {
      pipeline.zRemRangeByScore(key(accountId), 0, at);
      pipeline.zCard(key(accountId));
    }
    const results = await pipeline.exec();
    const online = new Set<string>();
    accountIds.forEach((accountId, index) => {
      const count = results[index * 2 + 1];
      if (typeof count === "number" && count > 0) online.add(accountId);
    });
    return online;
  }

  async close(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }
}

let store: PresenceStore | null = null;

/**
 * The store this process uses. Redis when it can be reached in five seconds,
 * this process's memory otherwise — and it says which, once, at boot.
 */
export async function createPresenceStore(redisUrl = process.env.REDIS_URL): Promise<PresenceStore> {
  if (!redisUrl?.trim()) {
    logger.info("REDIS_URL not set - presence is per-task");
    return new MemoryPresenceStore();
  }
  try {
    const { createClient } = (await import("redis")) as unknown as { createClient: (o: { url: string }) => RedisLike };
    const client = createClient({ url: redisUrl });
    client.on("error", (error) => logger.warn("Redis presence client error", error));
    await Promise.race([
      client.connect(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis connection timeout")), 5_000).unref()),
    ]);
    if (!client.isReady) throw new Error("Redis connected but not ready");
    logger.info("Presence store on Redis");
    return new RedisPresenceStore(client);
  } catch (error: unknown) {
    logger.warn("Redis unavailable - presence is per-task", error);
    return new MemoryPresenceStore();
  }
}

export function getPresenceStore(): PresenceStore {
  if (!store) store = new MemoryPresenceStore();
  return store;
}

export function setPresenceStore(next: PresenceStore | null): void {
  store = next;
}

/** Idempotent, and the only place the store is torn down. */
export async function closePresenceStore(): Promise<void> {
  const current = store;
  store = null;
  await current?.close();
}
