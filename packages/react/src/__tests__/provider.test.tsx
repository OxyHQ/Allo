import { renderHook, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useAlloClient, useAlloErrors, useConversations, useInstanceState, useOwnInstances, useSyncState, useTimeline } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, waitJoined, type TestClient } from "./helpers";

describe("AlloProvider", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("useAlloClient throws a clear message outside the provider", () => {
    expect(() => renderHook(() => useAlloClient())).toThrow(/no AlloProvider found.*<AlloProvider client=\{client\}>/);
    expect(() => renderHook(() => useConversations())).toThrow(/no AlloProvider found/);
  });

  it("useAlloClient returns the provided client and does not start it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web", "web", false);
    started.push(alice);
    const { result } = renderAlloHook(alice.client, () => ({ client: useAlloClient(), instance: useInstanceState(), sync: useSyncState() }));
    expect(result.current.client).toBe(alice.client);
    expect(result.current.instance.state).toBe("unregistered");
    expect(result.current.sync).toBe("idle");
    expect(server.requestLog).toHaveLength(0);
  });

  it("a re-render without a change keeps the same snapshot identities", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await alice.client.messages.send(conv.id, "one");
    await alice.client.sync.flush();

    const { result, rerender } = renderAlloHook(alice.client, () => ({
      conversations: useConversations(),
      timeline: useTimeline(conv.id),
      own: useOwnInstances(),
      instance: useInstanceState(),
    }));
    await rtlWaitFor(() => expect(result.current.timeline.items.length).toBe(1));
    const before = result.current;
    rerender();
    const after = result.current;
    expect(after.conversations).toBe(before.conversations);
    expect(after.timeline).toBe(before.timeline);
    expect(after.timeline.items).toBe(before.timeline.items);
    expect(after.timeline.send).toBe(before.timeline.send);
    expect(after.own).toBe(before.own);
    expect(after.own.instances).toBe(before.own.instances);
    expect(after.instance).toBe(before.instance);
    // and the snapshots are the client's own references, not copies
    expect(after.conversations).toBe(alice.client.conversations.list());
    expect(after.timeline.items).toBe(alice.client.messages.timeline(conv.id));
  });

  it("useSyncState reaches live and useAlloErrors receives what the client reports", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    started.push(alice);
    const seen: unknown[] = [];
    const { result } = renderAlloHook(alice.client, () => {
      useAlloErrors((e) => seen.push(e));
      return useSyncState();
    });
    await rtlWaitFor(() => expect(result.current).toBe("live"));
    server.faults.push({ match: (m, p) => m === "GET" && p.startsWith("/v1/sync"), times: 1, status: 500, code: "boom" });
    await alice.client.sync.now().catch(() => undefined);
    await rtlWaitFor(() => expect(seen.length).toBeGreaterThan(0));
  });
});
