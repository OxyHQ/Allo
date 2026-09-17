import { createAlloClient, type AlloClient } from "../client";
import { FakeAlloServer, createFakeAlloServer } from "../testing/fakeServer";
import { FakeSession, MemorySecrets, MemoryStorage } from "../testing/memoryAdapters";
import { until } from "../util/async";
import type { TimelineItemView } from "../types";
import type { Platform } from "@allo/shared-types";

export interface TestClient {
  client: AlloClient;
  storage: MemoryStorage;
  secrets: MemorySecrets;
  accountId: string;
  name: string;
}

export function fakeServer(): FakeAlloServer {
  return createFakeAlloServer();
}

export async function makeClient(
  server: FakeAlloServer,
  accountId: string,
  name: string,
  platform: Platform = "web",
  persisted?: { storage: MemoryStorage; secrets: MemorySecrets },
  start = true,
): Promise<TestClient> {
  const storage = persisted?.storage ?? new MemoryStorage();
  const secrets = persisted?.secrets ?? new MemorySecrets();
  const client = createAlloClient({
    baseUrl: server.baseUrl,
    appId: "allo",
    platform,
    displayName: name,
    session: FakeSession.for(accountId),
    storage,
    secrets,
    transport: { fetch: server.fetch, socketFactory: server.socketFactory },
    syncIntervalMs: 60_000,
    logger: process.env.ALLO_DEBUG
      ? {
          debug: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
          info: (m, meta) => console.log(`[${name}] ${m}`, meta ?? ""),
          warn: (m, meta) => console.log(`[${name}] WARN ${m}`, meta ?? ""),
          error: (m, meta) => console.log(`[${name}] ERROR ${m}`, meta ?? ""),
        }
      : undefined,
    keyPackageTarget: 6,
  });
  if (start) await client.start();
  return { client, storage, secrets, accountId, name };
}

export async function stopAll(...clients: TestClient[]): Promise<void> {
  for (const c of clients) await c.client.stop();
}

export function texts(items: TimelineItemView[]): string[] {
  return items.filter((i) => i.content.kind === "text").map((i) => (i.content as { body: string }).body);
}

export async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  await until(fn, timeoutMs, 15);
}

/** Waits until a client shows `text` in the conversation's timeline. */
export async function waitForText(c: TestClient, conversationId: string, text: string, timeoutMs = 8000): Promise<TimelineItemView> {
  await waitFor(() => texts(c.client.messages.timeline(conversationId)).includes(text), timeoutMs);
  return c.client.messages.timeline(conversationId).find((i) => i.content.kind === "text" && i.content.body === text)!;
}

export async function waitJoined(c: TestClient, conversationId: string, timeoutMs = 8000): Promise<void> {
  await waitFor(() => c.client.conversations.get(conversationId)?.joined === true, timeoutMs);
}

export async function flush(...clients: TestClient[]): Promise<void> {
  for (const c of clients) {
    await c.client.sync.flush();
    await c.client.sync.now();
  }
}
