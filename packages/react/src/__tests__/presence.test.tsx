import { waitFor as waitForDom } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { usePresence } from "../hooks/usePresence";
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

describe("usePresence", () => {
  it("draws an account as unknown until the server answers, then as online", async () => {
    const { alice, bob } = await pair();
    const { result } = renderAlloHook(alice.client, () => usePresence([bob.accountId]));

    expect(result.current.of(bob.accountId)).toEqual({ online: false, lastSeenAt: null, known: false });
    await waitForDom(() => expect(result.current.of(bob.accountId).online).toBe(true));
    expect(result.current.publishing).toBe(true);
  });

  it("says nothing about an account outside the watch set, however well the SDK knows it", async () => {
    const { alice, bob } = await pair();
    const { result } = renderAlloHook(alice.client, () => usePresence([bob.accountId]));
    await waitForDom(() => expect(result.current.of(bob.accountId).online).toBe(true));

    // A third account nobody asked about reads as unknown rather than offline:
    // the hook answers for what it watches and does not guess at the rest.
    expect(result.current.of("acc-carol-01")).toEqual({ online: false, lastSeenAt: null, known: false });
  });

  it("stops watching when the screen unmounts", async () => {
    const { alice, bob } = await pair();
    const { result, unmount } = renderAlloHook(alice.client, () => usePresence([bob.accountId]));
    await waitForDom(() => expect(result.current.of(bob.accountId).online).toBe(true));

    unmount();
    await waitForDom(() => expect(alice.client.presence.of(bob.accountId).known).toBe(false));
  });

  it("reports that it publishes nothing when the account has hidden its own presence", async () => {
    const { server, alice, bob } = await pair();
    server.presenceHidden.add(alice.accountId);
    const { result } = renderAlloHook(alice.client, () => usePresence([bob.accountId]));

    await waitForDom(() => expect(result.current.publishing).toBe(false));
    expect(result.current.of(bob.accountId).online).toBe(false);
  });

  it("keeps one identity for the watch set across renders with an equal list", async () => {
    const { alice, bob } = await pair();
    const { result, rerender } = renderAlloHook(alice.client, () => usePresence([bob.accountId]));
    await waitForDom(() => expect(result.current.of(bob.accountId).online).toBe(true));

    const before = result.current;
    rerender();
    expect(result.current).toBe(before);
  });

  it("answers on an unstarted client without looping", async () => {
    const server = fakeServer();
    const unstarted = await makeClient(server, "acc-alice-01", "Alice", "web", false);
    clients.push(unstarted);
    const { result } = renderAlloHook(unstarted.client, () => usePresence(["acc-bob-0001"]));
    expect(result.current.of("acc-bob-0001")).toEqual({ online: false, lastSeenAt: null, known: false });
    expect(result.current.publishing).toBe(true);
  });
});
