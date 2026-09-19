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
import { fakeServer, makeClient, stopAll, texts, waitFor, waitForText } from "./e2eHelpers";
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

/**
 * THE CONVERSATION THAT LOST EVERY DEVICE.
 *
 * Reported from the app: after re-enrolling, a DM answered "This device is
 * still being added to the conversation" and never stopped. It could not:
 * only a member already in the MLS group can commit an Add, the only leaf that
 * group ever had belonged to the device that was revoked, and a DM converges
 * on its `dm_key` — so "start a new conversation with that person" hands back
 * the same dead row. Two people could never speak again.
 */
describe("a conversation with no live device", () => {
  it("is revived on the next refresh, and messages flow again", async () => {
    const server = fakeServer();
    const mine = await makeClient(server, "acc-revive-0001", "Chrome");
    const conversation = await mine.client.conversations.createDirect("acc-revive-0002");
    await mine.client.messages.send(conversation.id, "before the lights went out");
    await mine.client.sync.flush();
    await mine.client.stop();

    // Every device in the group goes: this is what a sign-out, or the reclaim
    // of an account whose devices were lost, leaves behind.
    server.instancesOf("acc-revive-0001").forEach((i) => (i.status = "revoked"));
    const group = server.conversations.get(conversation.id)!;
    const deadGroupId = group.mlsGroupId; // a string, not a live reference to the row
    for (const [id, leaf] of group.leaves) group.leaves.set(id, { ...leaf, state: "removed" });

    // The account comes back on a new device, with nothing of its own.
    const fresh = await makeClient(server, "acc-revive-0001", "Chrome again");
    expect(fresh.client.instance.state()).toBe("active");

    const view = fresh.client.conversations.get(conversation.id);
    expect(view).toBeDefined();
    // The thing that was broken: this device holds a leaf again, so it can speak.
    expect(view!.joined).toBe(true);
    expect(server.conversations.get(conversation.id)!.mlsGroupId).not.toBe(deadGroupId);

    await fresh.client.messages.send(conversation.id, "still here");
    await fresh.client.sync.flush();
    expect(texts(fresh.client.messages.timeline(conversation.id))).toContain("still here");
    await stopAll(fresh);
  }, 30_000);

  it("leaves a conversation that still has a live device alone", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-revive-0101", "Alice");
    const bob = await makeClient(server, "acc-revive-0102", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.sync.flush();
    await bob.client.sync.now();

    const groupBefore = server.conversations.get(conversation.id)!.mlsGroupId;
    await bob.client.conversations.refresh();
    // Alice is still in it, so nothing is revived out from under her.
    expect(server.conversations.get(conversation.id)!.mlsGroupId).toBe(groupBefore);
    await stopAll(alice, bob);
  }, 30_000);
});

/**
 * THE CASE PEOPLE ACTUALLY HIT: a DM made before GroupInfos existed, whose
 * other device has not been opened since.
 *
 * Nothing can add this device — only a member inside a group may commit an
 * Add — and nothing can let it in by itself, because there is no GroupInfo to
 * join from. Reported twice from the app, the second time as "This device is
 * still being added to the conversation. Another device in the conversation
 * has to be online."
 *
 * "Wait for the other person to open their app" is not an answer a messenger
 * may give, so the DM is re-keyed instead. It costs nothing that was not
 * already gone: a device with no leaf could read none of it anyway.
 */
describe("a direct conversation with nobody able to let this device in", () => {
  it("re-keys itself and lets the person write, with the other side offline", async () => {
    const server = fakeServer();
    // Conversations made before GroupInfos existed publish none.
    server.keepGroupInfo = false;

    const alice = await makeClient(server, "acc-rekey-a", "Alice phone");
    const bob = await makeClient(server, "acc-rekey-b", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.messages.send(conversation.id, "from before");
    await alice.client.sync.flush();
    await waitForText(bob, conversation.id, "from before");
    await bob.client.stop();

    // Alice re-enrols: her old device is revoked, the new one has no leaf, and
    // Bob — the only device that could add her — is not running.
    await alice.client.stop();
    server.instancesOf("acc-rekey-a").forEach((i) => (i.status = "revoked"));
    const group = server.conversations.get(conversation.id)!;
    for (const [id, leaf] of group.leaves) {
      if (leaf.accountId === "acc-rekey-a") group.leaves.set(id, { ...leaf, state: "removed" });
    }
    expect([...group.leaves.values()].some((leaf) => leaf.state === "active")).toBe(true); // Bob's is still live

    const fresh = await makeClient(server, "acc-rekey-a", "Alice laptop");
    await waitFor(() => fresh.client.conversations.get(conversation.id)?.joined === true, 10_000);

    const view = fresh.client.conversations.get(conversation.id)!;
    expect(view.joined).toBe(true);
    expect(view.joinState).toBe("joined");

    // And she can actually speak in it.
    await fresh.client.messages.send(conversation.id, "I can write again");
    await fresh.client.sync.flush();
    expect(texts(fresh.client.messages.timeline(conversation.id))).toContain("I can write again");
    await stopAll(fresh);
  }, 30_000);

  it("never re-keys a GROUP out from under the people in it", async () => {
    const server = fakeServer();
    server.keepGroupInfo = false;
    const alice = await makeClient(server, "acc-rekey-c", "Alice");
    const bob = await makeClient(server, "acc-rekey-d", "Bob");
    const carol = await makeClient(server, "acc-rekey-e", "Carol");
    const conversation = await alice.client.conversations.createGroup([bob.accountId, carol.accountId]);
    await alice.client.sync.flush();

    const groupIdBefore = server.conversations.get(conversation.id)!.mlsGroupId;
    await alice.client.stop();
    server.instancesOf("acc-rekey-c").forEach((i) => (i.status = "revoked"));
    const g = server.conversations.get(conversation.id)!;
    for (const [id, leaf] of g.leaves) {
      if (leaf.accountId === "acc-rekey-c") g.leaves.set(id, { ...leaf, state: "removed" });
    }

    const fresh = await makeClient(server, "acc-rekey-c", "Alice laptop");
    await new Promise((resolve) => setTimeout(resolve, 500));
    // The group is untouched, and this device waits for a member, as it must.
    expect(server.conversations.get(conversation.id)!.mlsGroupId).toBe(groupIdBefore);
    expect(fresh.client.conversations.get(conversation.id)?.joined).toBe(false);
    await stopAll(fresh, bob, carol);
  }, 30_000);
});
