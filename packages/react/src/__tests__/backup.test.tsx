import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { validateRecoveryPhrase } from "@allo/core";
import { afterEach, describe, expect, it } from "vitest";
import { RecoveryPhraseError, useBackup, useConversations, useTimeline } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, texts, waitFor, waitJoined, type TestClient } from "./helpers";

describe("useBackup", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("enable returns a 12-word phrase once; a fresh device restores with it and refuses a wrong one", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    await alice.client.messages.send(conv.id, "one");
    await bob.client.messages.send(conv.id, "two");
    await waitFor(() => texts(alice.client.messages.timeline(conv.id)).length === 2);
    await alice.client.conversations.rename(conv.id, "A and B");

    const first = renderAlloHook(alice.client, () => useBackup());
    expect(first.result.current.status).toEqual({ enabled: false, lastBackupAt: null, eventCount: 0, remote: null, busy: false });
    await act(async () => {
      await first.result.current.refreshStatus();
    });
    expect(first.result.current.status.remote).toEqual({ exists: false, updatedAt: null });

    let phrase = "";
    await act(async () => {
      phrase = await first.result.current.enable();
    });
    expect(phrase.split(" ")).toHaveLength(12);
    expect(validateRecoveryPhrase(phrase)).toBe(true);
    await rtlWaitFor(() => expect(first.result.current.status.enabled).toBe(true));
    expect(first.result.current.status.lastBackupAt).not.toBeNull();
    expect(first.result.current.status.eventCount).toBeGreaterThan(0);
    expect(first.result.current.status.remote?.exists).toBe(true);
    expect(first.result.current.status.busy).toBe(false);
    // the phrase is handed to the caller and kept nowhere
    expect(new TextDecoder().decode(alice.storage.dump()).includes(phrase)).toBe(false);
    await expect(first.result.current.enable()).rejects.toThrow(/already enabled/);

    // every device lost: revoke and forget; a fresh install of the same account starts empty
    await alice.client.instance.revoke(alice.client.instanceId!);
    await alice.client.stop();
    const fresh = await makeClient(server, "acc-alice-01", "Alice new phone", "ios");
    started.push(fresh);
    expect(fresh.client.instance.state()).toBe("active");
    const restored = renderAlloHook(fresh.client, () => ({ backup: useBackup(), conversations: useConversations(), timeline: useTimeline(conv.id) }));
    // the server lists the DM for the account, but the fresh device holds none of its content
    expect(restored.result.current.conversations.map((c) => c.id)).toEqual([conv.id]);
    expect(restored.result.current.conversations[0].title).toBeNull();
    expect(restored.result.current.timeline.items).toEqual([]);
    await act(async () => {
      await restored.result.current.backup.refreshStatus();
    });
    expect(restored.result.current.backup.status.remote?.exists).toBe(true);

    server.requestLog.length = 0;
    const wrong = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
    await expect(restored.result.current.backup.restore(wrong)).rejects.toBeInstanceOf(RecoveryPhraseError);
    await expect(restored.result.current.backup.restore("not twelve words")).rejects.toBeInstanceOf(RecoveryPhraseError);
    expect(server.requestLog.some((r) => r.path.startsWith("/v1/blobs/"))).toBe(false);
    expect(restored.result.current.backup.status.enabled).toBe(false);
    expect(restored.result.current.timeline.items).toEqual([]);

    await act(async () => {
      await restored.result.current.backup.restore(phrase);
    });
    await rtlWaitFor(() => expect(restored.result.current.conversations[0]?.title).toBe("A and B"));
    await rtlWaitFor(() => expect(texts(restored.result.current.timeline.items)).toEqual(["one", "two"]));
    expect(restored.result.current.timeline.items[0].isOwn).toBe(true);
    expect(restored.result.current.backup.status.enabled).toBe(true);

    // refresh from the new device, then disable deletes and forgets
    await act(async () => {
      await restored.result.current.backup.refresh();
    });
    expect(server.backups.get("acc-alice-01")?.instanceId).toBe(fresh.client.instanceId);
    await act(async () => {
      await restored.result.current.backup.disable();
    });
    expect(restored.result.current.backup.status).toMatchObject({ enabled: false, remote: { exists: false } });
    expect(await fresh.secrets.get("allo.backup-key.acc-alice-01.allo")).toBeUndefined();
  });
});
