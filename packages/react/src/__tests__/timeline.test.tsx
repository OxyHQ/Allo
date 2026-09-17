import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useTimeline } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, texts, waitFor, waitJoined, type TestClient } from "./helpers";

describe("useTimeline", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("shows the local echo pending then accepted, the other party's message, and edit/react/markRead", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    const aliceHook = renderAlloHook(alice.client, () => useTimeline(conv.id));
    const bobHook = renderAlloHook(bob.client, () => useTimeline(conv.id));
    expect(aliceHook.result.current.items).toEqual([]);
    expect(aliceHook.result.current.reachedStart).toBe(true);

    // local echo: pending while alice's network is down, accepted once the server has it
    server.setOffline(alice.client.instanceId!, true);
    let localKey = "";
    await act(async () => {
      localKey = await aliceHook.result.current.send("hi bob");
    });
    await rtlWaitFor(() => expect(aliceHook.result.current.items.find((i) => i.localKey === localKey)?.sendState).toBe("pending"));
    const echo = aliceHook.result.current.items.find((i) => i.localKey === localKey)!;
    expect(echo.isOwn).toBe(true);
    expect(echo.seq).toBeNull();
    server.setOffline(alice.client.instanceId!, false);
    await rtlWaitFor(() => expect(aliceHook.result.current.items.find((i) => i.localKey === localKey)?.sendState).toBe("accepted"), { timeout: 10_000 });
    const accepted = aliceHook.result.current.items.find((i) => i.localKey === localKey)!;

    // the other party sees it
    await rtlWaitFor(() => expect(texts(bobHook.result.current.items)).toEqual(["hi bob"]));
    expect(bobHook.result.current.items[0].id).toBe(accepted.id);
    expect(bobHook.result.current.items[0].isOwn).toBe(false);

    // and their reply reaches alice's hook
    await act(async () => {
      await bobHook.result.current.send("hi alice", { replyTo: accepted.id });
    });
    await rtlWaitFor(() => expect(texts(aliceHook.result.current.items)).toEqual(["hi bob", "hi alice"]));
    expect(aliceHook.result.current.items[1].replyTo).toBe(accepted.id);

    // edit
    await act(async () => {
      await aliceHook.result.current.edit(accepted.id, "hi bob (edited)");
    });
    await rtlWaitFor(() => expect(bobHook.result.current.items[0].content).toEqual({ kind: "text", body: "hi bob (edited)", isEdited: true }));

    // react (toggle on)
    await act(async () => {
      await bobHook.result.current.react(accepted.id, "👍");
    });
    await rtlWaitFor(() => expect(aliceHook.result.current.items[0].reactions).toEqual([{ key: "👍", accountIds: ["acc-bob-0001"] }]));

    // markRead: bob reads → alice's message shows read
    await act(async () => {
      await bobHook.result.current.markRead();
    });
    await rtlWaitFor(() => expect(aliceHook.result.current.items[0].sendState).toBe("read"));

    // remove
    await act(async () => {
      await aliceHook.result.current.remove(accepted.id);
    });
    await rtlWaitFor(() => expect(bobHook.result.current.items[0].content).toEqual({ kind: "deleted" }));
  });

  it("windows the newest pageSize items and loadOlder widens the window without sliding it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    for (let i = 1; i <= 7; i++) await alice.client.messages.send(conv.id, `m${i}`);
    await alice.client.sync.flush();
    await waitFor(() => texts(alice.client.messages.timeline(conv.id)).length === 7);

    const { result } = renderAlloHook(alice.client, () => useTimeline(conv.id, { pageSize: 3 }));
    expect(texts(result.current.items)).toEqual(["m5", "m6", "m7"]);
    expect(result.current.reachedStart).toBe(false);

    await act(async () => {
      const page = await result.current.loadOlder();
      expect(texts(page.items)).toEqual(["m2", "m3", "m4"]);
      expect(page.reachedStart).toBe(false);
    });
    await rtlWaitFor(() => expect(texts(result.current.items)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7"]));
    expect(result.current.reachedStart).toBe(false);

    // a new message extends the window at the new end and keeps m2 at the old end
    await act(async () => {
      await result.current.send("m8");
    });
    await rtlWaitFor(() => expect(texts(result.current.items)).toEqual(["m2", "m3", "m4", "m5", "m6", "m7", "m8"]));

    // the last page is shorter than pageSize and says so
    await act(async () => {
      const page = await result.current.loadOlder();
      expect(texts(page.items)).toEqual(["m1"]);
      expect(page.reachedStart).toBe(true);
    });
    await rtlWaitFor(() => expect(result.current.reachedStart).toBe(true));
    expect(texts(result.current.items)).toEqual(["m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"]);
  });

  it("typing reflects the other party's setTyping", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await waitFor(() => alice.client.sync.state() === "live" && bob.client.sync.state() === "live");

    const { result } = renderAlloHook(alice.client, () => useTimeline(conv.id));
    expect(result.current.typing).toBe(false);
    await act(async () => {
      await bob.client.messages.setTyping(conv.id, true);
    });
    await rtlWaitFor(() => expect(result.current.typing).toBe(true));
    await act(async () => {
      await bob.client.messages.setTyping(conv.id, false);
    });
    await rtlWaitFor(() => expect(result.current.typing).toBe(false));
  });
});
