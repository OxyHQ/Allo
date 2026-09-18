import { act } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useBackup, useConversation, useConversations, useHistoryTransfer, useInstanceState, useOwnInstances, usePendingEnrollments, useSyncState, useTimeline, useUnreadCount } from "../index";
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

describe("hooks over a client that has not started", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("render without a loop and keep every snapshot's identity, then follow start() and reset()", async () => {
    // `AlloRoot` mounts the provider the moment the client is built and awaits `start()` afterwards,
    // so every hook renders at least once against a client whose store is not open yet.
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-02", "Alice web", "web", false);
    started.push(alice);

    const errors: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      let renders = 0;
      const { result, rerender } = renderAlloHook(
        alice.client,
        ({ tick }: { tick: number }) => {
          renders++;
          return {
            tick,
            conversations: useConversations(),
            conversation: useConversation("nope"),
            unread: useUnreadCount("nope"),
            timeline: useTimeline("nope"),
            instance: useInstanceState(),
            own: useOwnInstances(),
            pending: usePendingEnrollments(),
            history: useHistoryTransfer(),
            backup: useBackup(),
            sync: useSyncState(),
          };
        },
        { initialProps: { tick: 0 } },
      );
      const before = result.current;
      rerender({ tick: 1 });
      rerender({ tick: 2 });
      expect(renders).toBe(3);
      expect(errors.filter((e) => /getSnapshot should be cached|Maximum update depth/.test(e))).toEqual([]);
      expect(result.current.conversations).toBe(before.conversations);
      expect(result.current.conversations).toEqual([]);
      expect(result.current.conversation).toBeUndefined();
      expect(result.current.unread).toBe(0);
      expect(result.current.timeline.items).toBe(before.timeline.items);
      expect(result.current.timeline.items).toEqual([]);
      expect(result.current.instance.state).toBe("unregistered");
      expect(result.current.instance.instance).toBeNull();
      expect(result.current.own.instances).toBe(before.own.instances);
      expect(result.current.pending.pending).toBe(before.pending.pending);
      expect(result.current.history.pendingOffers).toBe(before.history.pendingOffers);
      expect(result.current.backup.status).toBe(before.backup.status);
      expect(result.current.sync).toBe("idle");

      // The client starts underneath the mounted hooks: the snapshots move to the started services' own caches.
      await act(async () => {
        await alice.client.start();
      });
      expect(result.current.instance.state).toBe("active");
      expect(result.current.own.instances).toHaveLength(1);
      expect(result.current.own.instances[0]?.isThis).toBe(true);
      const bob = await makeClient(server, "acc-bob-0002", "Bob iOS", "ios");
      started.push(bob);
      let conversationId = "";
      await act(async () => {
        conversationId = (await alice.client.conversations.createDirect("acc-bob-0002")).id;
      });
      expect(result.current.conversations.map((c) => c.id)).toEqual([conversationId]);

      // And back to nothing after reset(), still without a loop.
      await act(async () => {
        await alice.client.reset();
      });
      rerender({ tick: 3 });
      expect(result.current.instance.state).toBe("unregistered");
      expect(result.current.conversations).toEqual([]);
      expect(result.current.own.instances).toEqual([]);
      expect(errors.filter((e) => /getSnapshot should be cached|Maximum update depth/.test(e))).toEqual([]);
    } finally {
      console.error = original;
    }
  });
});
