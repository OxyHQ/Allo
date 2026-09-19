import { waitFor as waitForDom } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useStatuses } from "../hooks/useStatuses";
import { fakeServer, makeClient, renderAlloHook, stopAll, waitJoined, type TestClient } from "./helpers";

const clients: TestClient[] = [];
afterEach(async () => {
  await stopAll(...clients.splice(0));
});

async function pair() {
  const server = fakeServer();
  const alice = await makeClient(server, "acc-alice-01", "Alice");
  const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
  clients.push(alice, bob);
  const conv = await alice.client.conversations.createDirect(bob.accountId);
  await waitJoined(bob, conv.id);
  return { server, alice, bob };
}

describe("useStatuses", () => {
  it("draws what arrives, and separates your own", async () => {
    const { alice, bob } = await pair();
    const { result } = renderAlloHook(bob.client, () => useStatuses());
    expect(result.current.all).toEqual([]);

    await alice.client.statuses.post({ kind: "text", caption: "hola", audience: { mode: "all", accountIds: [] } });
    await waitForDom(() => expect(result.current.all).toHaveLength(1));
    expect(result.current.all[0].caption).toBe("hola");
    expect(result.current.mine).toEqual([]);

    const own = renderAlloHook(alice.client, () => useStatuses());
    await waitForDom(() => expect(own.result.current.mine).toHaveLength(1));
  });

  it("keeps one identity across renders while nothing changes", async () => {
    const { alice, bob } = await pair();
    await alice.client.statuses.post({ kind: "text", caption: "stable", audience: { mode: "all", accountIds: [] } });
    const { result, rerender } = renderAlloHook(bob.client, () => useStatuses());
    await waitForDom(() => expect(result.current.all).toHaveLength(1));

    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });

  it("answers an empty list on a client that was never started, without looping", async () => {
    const server = fakeServer();
    const unstarted = await makeClient(server, "acc-alice-01", "Alice", "web", false);
    clients.push(unstarted);
    const { result } = renderAlloHook(unstarted.client, () => useStatuses());
    expect(result.current.all).toEqual([]);
    expect(result.current.mine).toEqual([]);
  });
});
