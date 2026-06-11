/**
 * Optimistic update manager tests: confirm/fail lifecycle, rollback on failure
 * and the withOptimisticUpdate helper. Uses fake timers because confirm/fail
 * schedule delayed cleanup.
 */

import {
  OptimisticUpdateManager,
  withOptimisticUpdate,
  batchOptimisticUpdates,
} from "@/lib/optimistic/optimisticUpdates";

beforeEach(() => {
  jest.useFakeTimers();
});

afterEach(() => {
  jest.useRealTimers();
});

describe("OptimisticUpdateManager", () => {
  it("adds a pending update", () => {
    const manager = new OptimisticUpdateManager<{ text: string }>();
    const id = manager.add({ id: "m1", type: "send_message", data: { text: "hi" } });

    expect(id).toBe("m1");
    expect(manager.isPending("m1")).toBe(true);
    expect(manager.getPending()).toHaveLength(1);
  });

  it("confirms an update and cleans it up after the delay", () => {
    const manager = new OptimisticUpdateManager();
    manager.add({ id: "m1", type: "send_message", data: {} });

    manager.confirm("m1");
    expect(manager.get("m1")?.status).toBe("confirmed");

    jest.advanceTimersByTime(1000);
    expect(manager.get("m1")).toBeUndefined();
  });

  it("rolls back on failure", () => {
    const manager = new OptimisticUpdateManager();
    const rollback = jest.fn();
    manager.add({ id: "m1", type: "send_message", data: {}, rollback });

    manager.fail("m1");

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(manager.get("m1")?.status).toBe("failed");

    jest.advanceTimersByTime(2000);
    expect(manager.get("m1")).toBeUndefined();
  });

  it("does not roll back when rollback is disabled", () => {
    const manager = new OptimisticUpdateManager();
    const rollback = jest.fn();
    manager.add({ id: "m1", type: "x", data: {}, rollback });

    manager.fail("m1", false);
    expect(rollback).not.toHaveBeenCalled();
  });

  it("filters updates by type", () => {
    const manager = new OptimisticUpdateManager();
    manager.add({ id: "a", type: "send_message", data: {} });
    manager.add({ id: "b", type: "delete_message", data: {} });

    expect(manager.getByType("send_message")).toHaveLength(1);
    expect(manager.getByType("delete_message")).toHaveLength(1);
  });
});

describe("withOptimisticUpdate", () => {
  it("confirms on success and returns the result", async () => {
    const manager = new OptimisticUpdateManager();
    const result = await withOptimisticUpdate(
      manager,
      { id: "m1", type: "send_message", data: {} },
      async () => "server-result"
    );

    expect(result).toBe("server-result");
    expect(manager.get("m1")?.status).toBe("confirmed");
  });

  it("rolls back and rethrows on failure", async () => {
    const manager = new OptimisticUpdateManager();
    const rollback = jest.fn();

    await expect(
      withOptimisticUpdate(
        manager,
        { id: "m1", type: "send_message", data: {}, rollback },
        async () => {
          throw new Error("boom");
        }
      )
    ).rejects.toThrow("boom");

    expect(rollback).toHaveBeenCalledTimes(1);
    expect(manager.get("m1")?.status).toBe("failed");
  });
});

describe("batchOptimisticUpdates", () => {
  it("confirms all updates when every operation succeeds", async () => {
    const manager = new OptimisticUpdateManager();

    await batchOptimisticUpdates(manager, [
      { update: { id: "a", type: "del", data: {} }, fn: async () => 1 },
      { update: { id: "b", type: "del", data: {} }, fn: async () => 2 },
    ]);

    expect(manager.get("a")?.status).toBe("confirmed");
    expect(manager.get("b")?.status).toBe("confirmed");
  });

  it("fails and rolls back all updates when any operation rejects", async () => {
    const manager = new OptimisticUpdateManager();
    const rollbackA = jest.fn();
    const rollbackB = jest.fn();

    await expect(
      batchOptimisticUpdates(manager, [
        { update: { id: "a", type: "del", data: {}, rollback: rollbackA }, fn: async () => 1 },
        {
          update: { id: "b", type: "del", data: {}, rollback: rollbackB },
          fn: async () => {
            throw new Error("nope");
          },
        },
      ])
    ).rejects.toThrow("nope");

    expect(rollbackA).toHaveBeenCalledTimes(1);
    expect(rollbackB).toHaveBeenCalledTimes(1);
  });
});
