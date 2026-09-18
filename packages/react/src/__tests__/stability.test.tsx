import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBackup, useHistoryTransfer } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, waitFor, waitJoined, type TestClient } from "./helpers";

describe("useHistoryTransfer / useBackup referential stability", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("progress, pendingOffers, status and every callback keep their identity across unrelated re-renders and other topics' emissions", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    let renders = 0;
    const { result, rerender } = renderAlloHook(
      alice.client,
      ({ tick }: { tick: number }) => {
        renders++;
        return { tick, history: useHistoryTransfer(), backup: useBackup() };
      },
      { initialProps: { tick: 0 } },
    );
    const before = result.current;
    rerender({ tick: 1 });
    rerender({ tick: 2 });
    expect(result.current.tick).toBe(2);
    expect(renders).toBe(3);
    expect(result.current.history.progress).toBe(before.history.progress);
    expect(result.current.history.pendingOffers).toBe(before.history.pendingOffers);
    expect(result.current.history).toBe(before.history);
    expect(result.current.backup.status).toBe(before.backup.status);
    expect(result.current.backup).toBe(before.backup);

    // activity on other topics (timeline, conversations, sync) does not replace either snapshot
    await act(async () => {
      await alice.client.messages.send(conv.id, "hello");
      await alice.client.sync.flush();
    });
    await waitFor(() => bob.client.messages.timeline(conv.id).length === 1);
    await act(async () => {
      await alice.client.sync.now();
    });
    rerender({ tick: 3 });
    expect(result.current.history.progress).toBe(before.history.progress);
    expect(result.current.backup.status).toBe(before.backup.status);
    expect(result.current.history.accept).toBe(before.history.accept);
    expect(result.current.history.refresh).toBe(before.history.refresh);
    expect(result.current.backup.enable).toBe(before.backup.enable);
    expect(result.current.backup.restore).toBe(before.backup.restore);
    expect(result.current.backup.refreshStatus).toBe(before.backup.refreshStatus);

    // and its own topic does: refreshStatus fills `remote`
    await act(async () => {
      await result.current.backup.refreshStatus();
    });
    expect(result.current.backup.status).not.toBe(before.backup.status);
    expect(result.current.backup.status.remote).toEqual({ exists: false, updatedAt: null });
    expect(result.current.history.progress).toBe(before.history.progress);
  });
});
