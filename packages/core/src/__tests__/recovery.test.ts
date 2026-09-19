/**
 * THE TWO WAYS A DEVICE GETS BACK, when the thing it lost is not recoverable.
 *
 * Both start from the same accident — a secret that is no longer there — and
 * they differ in WHICH one, which is the only thing that decides whether the
 * account can carry on:
 *
 *   the storage key   the rows it encrypted are unreadable by anyone for ever,
 *                     so they go, and the SIGNING key that survives lets the
 *                     device adopt the instance it already has. It stays
 *                     active. Nobody is asked to approve anything.
 *
 *   the signing key   nothing can speak for that instance again. The device
 *                     enrols anew and waits — and if the instance it lost was
 *                     the account's last active one, waits for ever, because
 *                     the only thing that could approve it is the instance it
 *                     just lost. That is the dead end `reclaimAccount()`
 *                     exists for.
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll } from "./e2eHelpers";
import { storageKeyName } from "../crypto/atRest";
import { instanceKeyName } from "../instance/manager";

const ACCOUNT = "acc-recovery-0001";

describe("a device that lost a secret", () => {
  it("drops the rows it can no longer read and keeps its instance when only the STORAGE key is gone", async () => {
    const server = fakeServer();
    const first = await makeClient(server, ACCOUNT, "Chrome");
    const conversation = await first.client.conversations.createDirect("acc-recovery-0002");
    await first.client.messages.send(conversation.id, "before");
    await first.client.sync.flush();
    const instanceId = first.client.instanceId;
    await first.client.stop();

    // The storage key alone goes. The rows it wrote are still on disk and
    // nothing will ever decrypt them again.
    await first.secrets.delete(storageKeyName(ACCOUNT, "allo"));
    expect((await first.storage.list(`allo/allo/${ACCOUNT}/`)).length).toBeGreaterThan(0);

    const again = await makeClient(server, ACCOUNT, "Chrome", "web", { storage: first.storage, secrets: first.secrets });

    // Adopted, not re-enrolled: the same instance, still active, and the
    // server was asked to register a second time only to be told the key it
    // presented is already enrolled.
    expect(again.client.instance.state()).toBe("active");
    expect(again.client.instanceId).toBe(instanceId);
    await stopAll(again);
  }, 30_000);

  it("gets the account back from a device that can no longer approve, when the SIGNING key is gone", async () => {
    const server = fakeServer();
    const lost = await makeClient(server, ACCOUNT, "Chrome");
    const ghostId = lost.client.instanceId;
    expect(lost.client.instance.state()).toBe("active");
    await lost.client.stop();

    // Site data cleared: this device keeps nothing, and the server still calls
    // that instance active.
    const fresh = await makeClient(server, ACCOUNT, "Chrome again");
    expect(fresh.client.instance.state()).toBe("pending-approval");
    expect(fresh.client.instanceId).not.toBe(ghostId);
    // And there is nobody to approve it: the one active instance is the ghost.
    expect(fresh.client.instance.pending()).toEqual([]);

    await fresh.client.reclaimAccount();

    // This device is the account's device now, and the ghost is revoked.
    expect(fresh.client.instance.state()).toBe("active");
    const listed = server.instancesOf(ACCOUNT);
    expect(listed.find((i) => i.id === ghostId)?.status).toBe("revoked");
    expect(listed.filter((i) => i.status === "active")).toHaveLength(1);
    await stopAll(fresh);
  }, 30_000);

  it("leaves the signing key unusable for its own sake: a wiped device cannot revoke what it no longer holds", async () => {
    const server = fakeServer();
    const device = await makeClient(server, ACCOUNT, "Chrome");
    const instanceId = device.client.instanceId;

    // What a sign-out does while the session is alive, which is the only time
    // the revoke can land.
    const outcome = await device.client.reset();
    expect(outcome).toEqual({ revoked: "done" });
    expect(await device.secrets.get(instanceKeyName(ACCOUNT, "allo"))).toBeUndefined();
    expect(server.instancesOf(ACCOUNT).find((i) => i.id === instanceId)?.status).toBe("revoked");

    // The account has no active instance, so the next device to arrive is the
    // bootstrap one and comes back active rather than waiting.
    const next = await makeClient(server, ACCOUNT, "Phone", "ios", { storage: device.storage, secrets: device.secrets });
    expect(next.client.instance.state()).toBe("active");
    await stopAll(next);
  }, 30_000);
});

/**
 * A key package is never expired and no sweep collects one, so whatever a
 * client uploads it keeps for ever — on the server and, with its private half,
 * on the device. A client that cannot ask how many the server holds has to
 * assume zero, and a fresh client assumes it on every start.
 *
 * Measured in a browser before `GET /v1/key-packages` existed: five reloads
 * turned 21 local rows into 125.
 */
describe("the key package stock", () => {
  it("is topped up to the target rather than added to on every start", async () => {
    const server = fakeServer();
    const first = await makeClient(server, "acc-stock-0001", "Chrome");
    const afterFirst = server.keyPackages.get(first.client.instanceId!)?.length ?? 0;
    expect(afterFirst).toBeGreaterThan(0);
    await first.client.stop();

    // Three more starts on the same device: nothing was consumed, so nothing
    // needs uploading.
    for (let i = 0; i < 3; i += 1) {
      const again = await makeClient(server, "acc-stock-0001", "Chrome", "web", { storage: first.storage, secrets: first.secrets });
      expect(server.keyPackages.get(again.client.instanceId!)?.length ?? 0).toBe(afterFirst);
      await again.client.stop();
    }

    // And the private halves on disk did not multiply either.
    const rows = (await first.storage.list(`allo/allo/acc-stock-0001/`)).filter((key) => key.includes("keyPackage"));
    expect(rows).toHaveLength(afterFirst);
  }, 30_000);
});
