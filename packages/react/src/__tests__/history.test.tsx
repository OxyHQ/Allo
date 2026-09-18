import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { HistoryPhase } from "../index";
import { useHistoryTransfer, useTimeline } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, texts, waitFor, waitJoined, type TestClient } from "./helpers";

describe("useHistoryTransfer", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("a newly approved second device watches progress leave idle and ends up with the pre-join DM timeline", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bobIos);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bobIos, conv.id);
    await alice.client.messages.send(conv.id, "one");
    await bobIos.client.messages.send(conv.id, "two");
    await alice.client.messages.send(conv.id, "three");
    await waitFor(() => texts(bobIos.client.messages.timeline(conv.id)).length === 3);
    await waitFor(() => texts(alice.client.messages.timeline(conv.id)).length === 3);

    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop");
    started.push(bobDesktop);
    const phases = new Set<HistoryPhase>();
    const desktop = renderAlloHook(bobDesktop.client, () => {
      const transfer = useHistoryTransfer();
      phases.add(transfer.progress.phase);
      return { transfer, timeline: useTimeline(conv.id) };
    });
    expect(desktop.result.current.transfer.progress).toEqual({ phase: "idle", done: 0, total: 0 });
    expect(desktop.result.current.transfer.pendingOffers).toEqual([]);
    expect(desktop.result.current.timeline.items).toEqual([]);

    await bobIos.client.instance.refreshPending();
    await act(async () => {
      await bobIos.client.instance.approve(bobDesktop.client.instanceId!);
    });
    await rtlWaitFor(() => expect(bobDesktop.client.instance.state()).toBe("active"), { timeout: 10_000 });
    // the elector adds the leaf on its next sync once the desktop has key packages up, and offers history right after
    await waitFor(() => (server.keyPackages.get(bobDesktop.client.instanceId!)?.length ?? 0) > 0);
    await act(async () => {
      await bobIos.client.sync.now();
    });
    await rtlWaitFor(() => expect(texts(desktop.result.current.timeline.items)).toEqual(["one", "two", "three"]), { timeout: 15_000 });
    await rtlWaitFor(() => expect(desktop.result.current.transfer.progress.phase).toBe("idle"));
    expect([...phases].some((p) => p !== "idle")).toBe(true);
    expect(desktop.result.current.timeline.items.find((i) => i.content.kind === "text" && i.content.body === "two")?.isOwn).toBe(true);
    expect(desktop.result.current.timeline.items.every((i) => i.seq !== null)).toBe(true);
    // the offer was consumed; nothing is left pending after a re-list
    await act(async () => {
      await desktop.result.current.transfer.refresh();
    });
    expect(desktop.result.current.transfer.pendingOffers).toEqual([]);
    expect([...server.historyOffers.values()].map((o) => o.status)).toEqual(["consumed"]);

    // the new device is a live member too
    await waitJoined(bobDesktop, conv.id, 10_000);
    await act(async () => {
      await alice.client.messages.send(conv.id, "four");
    });
    await rtlWaitFor(() => expect(texts(desktop.result.current.timeline.items)).toEqual(["one", "two", "three", "four"]), { timeout: 10_000 });
  });

  it("accept refuses an unknown offer id", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    started.push(alice);
    const { result } = renderAlloHook(alice.client, () => useHistoryTransfer());
    await expect(result.current.accept("no-such-offer")).rejects.toThrow(/no-such-offer/);
  });
});
