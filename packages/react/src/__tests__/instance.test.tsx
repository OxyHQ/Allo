import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useInstanceState, useOwnInstances, usePendingEnrollments } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, type TestClient } from "./helpers";

describe("useInstanceState / usePendingEnrollments / useOwnInstances", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("a second device goes pending-approval, then active once the first approves it", async () => {
    const server = fakeServer();
    const bobIos = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(bobIos);
    const first = renderAlloHook(bobIos.client, () => useInstanceState());
    expect(first.result.current.state).toBe("active");
    expect(first.result.current.instance?.isThis).toBe(true);
    expect(first.result.current.error).toBeUndefined();

    // the hook is mounted before start() so it observes the transition
    const bobDesktop = await makeClient(server, "acc-bob-0001", "Bob desktop", "desktop", false);
    started.push(bobDesktop);
    const second = renderAlloHook(bobDesktop.client, () => useInstanceState());
    expect(second.result.current.state).toBe("unregistered");
    expect(second.result.current.instance).toBeNull();
    await act(async () => {
      await bobDesktop.client.start();
    });
    await rtlWaitFor(() => expect(second.result.current.state).toBe("pending-approval"));
    expect(second.result.current.instance?.status).toBe("pending");

    const approver = renderAlloHook(bobIos.client, () => ({ pending: usePendingEnrollments(), own: useOwnInstances() }));
    await act(async () => {
      await approver.result.current.pending.refresh();
    });
    await rtlWaitFor(() => expect(approver.result.current.pending.pending).toHaveLength(1));
    const enrollment = approver.result.current.pending.pending[0];
    expect(enrollment.instance.id).toBe(bobDesktop.client.instanceId);
    expect(enrollment.fingerprint).toMatch(/^[0-9a-f]{4}( [0-9a-f]{4}){3}$/);

    await expect(approver.result.current.pending.approve(enrollment.instance.id, "not-the-challenge")).rejects.toThrow(/challenge/);
    await act(async () => {
      await approver.result.current.pending.approve(enrollment.instance.id, enrollment.challenge);
    });
    await rtlWaitFor(() => expect(approver.result.current.pending.pending).toHaveLength(0));
    await rtlWaitFor(() => expect(second.result.current.state).toBe("active"), { timeout: 10_000 });
    expect(second.result.current.instance?.status).toBe("active");

    await act(async () => {
      await approver.result.current.own.refresh();
    });
    await rtlWaitFor(() => expect(approver.result.current.own.instances.map((i) => i.id).sort()).toEqual([bobIos.client.instanceId, bobDesktop.client.instanceId].sort()));
    expect(approver.result.current.own.instances.find((i) => i.isThis)?.id).toBe(bobIos.client.instanceId);

    // revoke from the first device: the second's hook sees it
    await act(async () => {
      await approver.result.current.own.revoke(bobDesktop.client.instanceId!);
    });
    await rtlWaitFor(() => expect(second.result.current.state).toBe("revoked"), { timeout: 10_000 });
  });
});
