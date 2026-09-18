/**
 * The real SDK against the real backend: what every `integration/*.realdb`
 * suite shares.
 *
 * `createApp` with the production `requireInstance`, the production Socket.IO
 * server and a throwaway, fully migrated Postgres; `@allo/core` clients over
 * real HTTP and real sockets on an ephemeral port. The only double is Oxy: a
 * bearer of the form `test:<accountId>` names the account, on HTTP and on the
 * handshake.
 *
 * Each suite boots its own harness (`beforeAll(() => h.boot())`), because
 * vitest runs files in separate workers and the backend's Postgres handle is
 * module-global.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { eq } from "drizzle-orm";
import { createAlloClient, testing, type AlloClient, type OxySessionAdapter, type TimelineItemView, type TransportOptions } from "@allo/core";
import type { Platform } from "@allo/shared-types";
import { createApp } from "../../app";
import { checkPostgresHealth, closePostgres, connectPostgres, getDb, type AlloDatabase } from "../../db";
import * as schema from "../../db/schema";
import { setUpTestDatabase, type TestDatabaseHandle } from "../../db/testDatabase";
import { requireInstance } from "../../middleware/instanceAuth";
import { requireOxySession } from "../../middleware/oxySession";
import { clearRealtime, setRealtime } from "../../runtime/realtime";
import { createSocketServer, type SocketRuntime } from "../../runtime/socket";

const { MemorySecrets, MemoryStorage } = testing;

export const TOKEN_PREFIX = "test:";

/** Oxy's HTTP half: `Authorization: Bearer test:<accountId>` → `req.userId`. */
export const bearerAuth: RequestHandler = (req, _res, next) => {
  const header = req.get("authorization") ?? "";
  if (header.startsWith(`Bearer ${TOKEN_PREFIX}`)) {
    const accountId = header.slice(`Bearer ${TOKEN_PREFIX}`.length);
    Reflect.set(req, "userId", accountId);
    Reflect.set(req, "user", { id: accountId });
  }
  next();
};

/** Oxy's socket half: the same bearer in `handshake.auth.token`. */
export const socketOxy = {
  authSocket: () => async (socket: unknown, next: (err?: Error) => void) => {
    const s = socket as { handshake: { auth: Record<string, unknown> }; data: Record<string, unknown> };
    const token = s.handshake.auth.token;
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX)) return next(new Error("Authentication required"));
    s.data.userId = token.slice(TOKEN_PREFIX.length);
    next();
  },
};

export function sessionFor(accountId: string): OxySessionAdapter {
  return {
    getAccessToken: async () => `${TOKEN_PREFIX}${accountId}`,
    getAccountId: () => accountId,
    subscribe: () => () => undefined,
  };
}

export interface TestClient {
  client: AlloClient;
  accountId: string;
  name: string;
  storage: InstanceType<typeof MemoryStorage>;
  secrets: InstanceType<typeof MemorySecrets>;
}

export interface MakeClientOptions {
  /** Default true. */
  start?: boolean;
  /** Reuse an earlier client's adapters to simulate a restart on the same device. */
  storage?: InstanceType<typeof MemoryStorage>;
  secrets?: InstanceType<typeof MemorySecrets>;
  /** A custom `fetch` or socket factory, to observe what the SDK puts on the wire. */
  transport?: TransportOptions;
  backupDebounceMs?: number;
}

export const texts = (items: TimelineItemView[]): string[] =>
  items.filter((i) => i.content.kind === "text").map((i) => (i.content as { body: string }).body);

/** Poll a sync or async predicate; throws with the name of what never came true. */
export async function waitFor(fn: () => boolean | Promise<boolean>, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await fn()) return;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms: ${fn.toString().slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

export async function waitForText(c: TestClient, conversationId: string, text: string, timeoutMs = 15_000): Promise<TimelineItemView> {
  await waitFor(() => texts(c.client.messages.timeline(conversationId)).includes(text), timeoutMs);
  return c.client.messages.timeline(conversationId).find((i) => i.content.kind === "text" && i.content.body === text)!;
}

export const waitJoined = (c: TestClient, conversationId: string, timeoutMs = 20_000) =>
  waitFor(() => c.client.conversations.get(conversationId)?.joined === true, timeoutMs);

export async function stopAll(...clients: TestClient[]): Promise<void> {
  for (const c of clients) await c.client.stop();
}

export class Harness {
  handle!: TestDatabaseHandle;
  db!: AlloDatabase;
  server!: http.Server;
  sockets!: SocketRuntime;
  baseUrl = "";
  /** Every text sent through `unique()`, for the end-of-suite plaintext search. */
  readonly sent: string[] = [];
  private sequence = 0;
  private uniqueAccount = 0;

  async boot(): Promise<void> {
    this.handle = await setUpTestDatabase();
    this.db = connectPostgres(this.handle.databaseUrl);
    const pass: RequestHandler = (_req, _res, next) => next();
    const app = createApp({
      auth: bearerAuth,
      v1Auth: [bearerAuth, requireOxySession],
      instanceAuth: requireInstance({ getDb }),
      rateLimit: pass,
      cors: pass,
      webhooks: express.Router(),
      api: { profile: express.Router(), reports: express.Router(), directory: express.Router() },
      checkPostgres: checkPostgresHealth,
      blobMaxBytes: 1024 * 1024,
    });
    this.server = http.createServer(app);
    this.sockets = createSocketServer(this.server, { oxy: socketOxy, instanceAuth: { getDb } });
    setRealtime(this.sockets.realtime);
    await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve));
    this.baseUrl = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async shutdown(): Promise<void> {
    if (this.sockets) {
      clearRealtime(this.sockets.realtime);
      await new Promise<void>((resolve) => this.sockets.io.close(() => resolve()));
    }
    if (this.server) await new Promise<void>((resolve) => this.server.close(() => resolve()));
    await closePostgres();
    await this.handle?.drop();
  }

  async makeClient(accountId: string, name: string, platform: Platform, options: MakeClientOptions = {}): Promise<TestClient> {
    this.sequence += 1;
    const storage = options.storage ?? new MemoryStorage();
    const secrets = options.secrets ?? new MemorySecrets();
    const client = createAlloClient({
      baseUrl: this.baseUrl,
      appId: "allo",
      platform,
      displayName: `${name} #${this.sequence}`,
      session: sessionFor(accountId),
      storage,
      secrets,
      transport: options.transport,
      syncIntervalMs: 60_000,
      keyPackageTarget: 6,
      backupDebounceMs: options.backupDebounceMs,
      logger: process.env.ALLO_DEBUG
        ? {
            debug: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
            info: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
            warn: (m, meta) => console.log(`[${name}] WARN ${m}`, meta ?? ""),
            error: (m, meta) => console.log(`[${name}] ERROR ${m}`, meta ?? ""),
          }
        : undefined,
    });
    if (options.start !== false) await client.start();
    return { client, accountId, name, storage, secrets };
  }

  async keyPackagesOf(instanceId: string): Promise<number> {
    const rows = await this.db.select().from(schema.keyPackages).where(eq(schema.keyPackages.instanceId, instanceId));
    return rows.length;
  }

  /** Every stored event payload, decoded, so a plaintext search covers the whole log. */
  async allPayloads(): Promise<Buffer[]> {
    const rows = await this.db.select({ payload: schema.conversationEvents.payload }).from(schema.conversationEvents);
    return rows.map((row) => Buffer.from(row.payload));
  }

  /** Every stored blob's bytes (media, thumbnails, archive chunks), for the same search. */
  async allBlobBytes(): Promise<Buffer[]> {
    const rows = await this.db.select({ data: schema.blobBytes.data }).from(schema.blobBytes);
    return rows.map((row) => Buffer.from(row.data));
  }

  /** A message text no other test could have sent, remembered for the plaintext search. */
  unique(text: string): string {
    const t = `${text} [${Date.now().toString(36)}-${this.sequence}]`;
    this.sent.push(t);
    return t;
  }

  account(name: string): string {
    return `acc-${name}-${String(++this.uniqueAccount).padStart(4, "0")}`;
  }
}
