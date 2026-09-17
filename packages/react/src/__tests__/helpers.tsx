/**
 * Test harness: real `@allo/core` clients against the in-memory fake server,
 * and `renderHook` wrapped in `AlloProvider`.
 */
import { createAlloClient, testing, type AlloClient, type TimelineItemView } from "@allo/core";
import type { Platform } from "@allo/shared-types";
import { renderHook, type RenderHookOptions, type RenderHookResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { AlloProvider } from "../AlloProvider";

const { createFakeAlloServer, FakeSession, MemorySecrets, MemoryStorage, until } = testing;
type FakeAlloServer = ReturnType<typeof createFakeAlloServer>;

export interface TestClient {
  client: AlloClient;
  storage: InstanceType<typeof MemoryStorage>;
  secrets: InstanceType<typeof MemorySecrets>;
  accountId: string;
}

export function fakeServer(): FakeAlloServer {
  return createFakeAlloServer();
}

export async function makeClient(server: FakeAlloServer, accountId: string, name: string, platform: Platform = "web", start = true): Promise<TestClient> {
  const storage = new MemoryStorage();
  const secrets = new MemorySecrets();
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
    keyPackageTarget: 6,
  });
  if (start) await client.start();
  return { client, storage, secrets, accountId };
}

export async function stopAll(...clients: TestClient[]): Promise<void> {
  for (const c of clients) await c.client.stop();
}

export async function waitFor(fn: () => boolean, timeoutMs = 8000): Promise<void> {
  await until(fn, timeoutMs, 15);
}

export function texts(items: TimelineItemView[]): string[] {
  return items.filter((i) => i.content.kind === "text").map((i) => (i.content as { body: string }).body);
}

export async function waitJoined(c: TestClient, conversationId: string, timeoutMs = 8000): Promise<void> {
  await waitFor(() => c.client.conversations.get(conversationId)?.joined === true, timeoutMs);
}

/** `renderHook` with the tree wrapped in `<AlloProvider client={client}>`. */
export function renderAlloHook<Result, Props>(
  client: AlloClient,
  hook: (props: Props) => Result,
  options?: Omit<RenderHookOptions<Props>, "wrapper">,
): RenderHookResult<Result, Props> {
  const wrapper = ({ children }: { children: ReactNode }) => <AlloProvider client={client}>{children}</AlloProvider>;
  return renderHook(hook, { ...options, wrapper });
}
