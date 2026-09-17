/**
 * The Redis adapter for Socket.IO, so a room emit on one ECS task reaches a
 * socket on another. Optional on `REDIS_URL`; never throws. Without it (or
 * when Redis cannot be reached in 5 s) the server runs single-instance, which
 * is also what local development looks like.
 */

import type { Server as SocketIOServer } from "socket.io";
import { logger } from "../utils/logger";

type RedisClient = { connect(): Promise<unknown>; quit(): Promise<unknown>; isOpen: boolean; isReady: boolean; on(event: string, cb: (e: unknown) => void): unknown };

let clients: { publisher: RedisClient; subscriber: RedisClient } | null = null;

export async function attachSocketRedisAdapter(io: SocketIOServer, redisUrl = process.env.REDIS_URL): Promise<boolean> {
  if (!redisUrl?.trim()) {
    logger.info("REDIS_URL not set - Socket.IO running in single-instance mode");
    return false;
  }
  try {
    const { createClient } = (await import("redis")) as unknown as { createClient: (o: { url: string }) => RedisClient };
    const { createAdapter } = (await import("@socket.io/redis-adapter")) as unknown as {
      createAdapter: (pub: unknown, sub: unknown) => Parameters<SocketIOServer["adapter"]>[0];
    };
    const publisher = createClient({ url: redisUrl });
    const subscriber = createClient({ url: redisUrl });
    for (const client of [publisher, subscriber]) client.on("error", (error) => logger.warn("Redis client error", error));
    clients = { publisher, subscriber };
    await Promise.race([
      Promise.all([publisher.connect(), subscriber.connect()]),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis connection timeout")), 5_000).unref()),
    ]);
    if (!publisher.isReady || !subscriber.isReady) throw new Error("Redis clients connected but not ready");
    io.adapter(createAdapter(publisher, subscriber));
    logger.info("Socket.IO Redis adapter attached");
    return true;
  } catch (error: unknown) {
    await closeSocketRedisAdapter();
    logger.warn("Redis unavailable - Socket.IO running in single-instance mode", error);
    return false;
  }
}

/** Idempotent. */
export async function closeSocketRedisAdapter(): Promise<void> {
  if (!clients) return;
  const { publisher, subscriber } = clients;
  clients = null;
  await Promise.allSettled([
    publisher.isOpen ? publisher.quit() : Promise.resolve(),
    subscriber.isOpen ? subscriber.quit() : Promise.resolve(),
  ]);
}
