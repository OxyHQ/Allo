import { describe, expect, it } from "vitest";
import { uuidV7 } from "../util/ids";
import { project } from "../messages/projection";
import type { EventRecord, OutboxItemRecord } from "../storage/records";
import { fakeServer, makeClient, stopAll } from "./e2eHelpers";

describe("ids", () => {
  it("uuid v7 ids minted in the same millisecond still sort in creation order", () => {
    const ids = Array.from({ length: 500 }, () => uuidV7(1_700_000_000_000));
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(500);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

function ev(p: Partial<EventRecord> & Pick<EventRecord, "id" | "seq" | "senderAccountId" | "message">): EventRecord {
  return { conversationId: "c", kind: "app_message", epoch: 1, senderInstanceId: "i", createdAt: "2026-01-01T00:00:00.000Z", localKey: null, failure: null, system: null, ...p };
}

describe("timeline projection", () => {
  it("folds edits, deletes, reactions, read receipts and local echoes", () => {
    const events: EventRecord[] = [
      ev({ id: "e1", seq: 4, senderAccountId: "me", message: { v: 1, t: "text", body: "hello" }, localKey: "k1" }),
      ev({ id: "e2", seq: 5, senderAccountId: "them", message: { v: 1, t: "text", body: "hi", replyTo: { kind: "event", conversationId: "c", eventId: "e1" } } }),
      ev({ id: "e3", seq: 6, senderAccountId: "them", message: { v: 1, t: "edit", target: { kind: "event", conversationId: "c", eventId: "e1" }, body: "hacked" } }), // not the author: ignored
      ev({ id: "e4", seq: 7, senderAccountId: "me", message: { v: 1, t: "edit", target: { kind: "local", conversationId: "c", idempotencyKey: "k1" }, body: "hello!" } }),
      ev({ id: "e5", seq: 8, senderAccountId: "them", message: { v: 1, t: "reaction", target: { kind: "event", conversationId: "c", eventId: "e1" }, key: "x", op: "add" } }),
      ev({ id: "e6", seq: 9, senderAccountId: "them", message: { v: 1, t: "read", upTo: { kind: "event", conversationId: "c", eventId: "e1" } } }),
      ev({ id: "e7", seq: 10, senderAccountId: "them", message: null, failure: "undecryptable" }),
    ];
    const outbox: OutboxItemRecord[] = [
      { id: "o1", conversationId: "c", kind: "app_message", createdAt: "2026-01-01T00:00:01.000Z", attempts: 0, state: "pending", failure: null, message: { v: 1, t: "text", body: "pending one" }, commit: null, blobIds: [] },
      { id: "o2", conversationId: "c", kind: "app_message", createdAt: "2026-01-01T00:00:02.000Z", attempts: 3, state: "failed", failure: "x", message: { v: 1, t: "delete", target: { kind: "event", conversationId: "c", eventId: "e2" } }, commit: null, blobIds: [] },
    ];
    const items = project({ conversationId: "c", events, outbox, accountId: "me", instanceId: "i" });
    expect(items.map((i) => i.id)).toEqual(["e1", "e2", "e7", "o1"]);
    expect(items[0]).toMatchObject({ content: { kind: "text", body: "hello!", isEdited: true }, sendState: "read", reactions: [{ key: "x", accountIds: ["them"] }], localKey: "k1" });
    expect(items[1]).toMatchObject({ content: { kind: "text", body: "hi", isEdited: false }, replyTo: "e1", isOwn: false, sendState: "accepted" });
    expect(items[2].content).toEqual({ kind: "undecryptable", reason: "undecryptable" });
    expect(items[3]).toMatchObject({ sendState: "pending", isOwn: true, seq: null });
  });
});

describe("fake server contract validation", () => {
  it("rejects a body that drifts from the shared-types schema with validation_failed", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const res = await server.fetch(`${server.baseUrl}/v1/instances`, {
      method: "POST",
      headers: { authorization: "Bearer fake-token:acc-alice-01", "content-type": "application/json" },
      body: JSON.stringify({ appId: "allo", platform: "toaster", displayName: "x", signingPublicKey: "short" }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation_failed");
    await stopAll(alice);
  });
});

describe("the facade before start() and after reset()", () => {
  it("answers every subscribable getter with the same reference on every call", async () => {
    // `useSyncExternalStore` re-renders whenever two consecutive reads differ by identity, and
    // the app mounts its screens over a client that has not finished `start()` yet.
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-unstarted", "Alice", "web", undefined, false);
    const { client } = alice;
    const reads = () => ({
      instances: client.instance.list(),
      pending: client.instance.pending(),
      current: client.instance.current(),
      conversations: client.conversations.list(),
      conversation: client.conversations.get("nope"),
      timeline: client.messages.timeline("nope"),
      unread: client.messages.unreadCount("nope"),
      typing: client.messages.isTyping("nope"),
      progress: client.history.progress(),
      offers: client.history.pendingOffers(),
      backup: client.backup.status(),
      state: client.instance.state(),
      sync: client.sync.state(),
    });
    const first = reads();
    const second = reads();
    for (const key of Object.keys(first) as (keyof typeof first)[]) expect(second[key], key).toBe(first[key]);
    expect(first.instances).toEqual([]);
    expect(first.timeline).toEqual([]);
    expect(first.state).toBe("unregistered");
    // A shared empty answer must not be mutable through one caller.
    expect(() => (first.conversations as unknown[]).push(1)).toThrow();

    await client.start();
    expect(client.instance.state()).toBe("active");
    expect(client.instance.list()).toHaveLength(1);

    await client.reset();
    const after = reads();
    expect(reads().instances).toBe(after.instances);
    expect(reads().conversations).toBe(after.conversations);
    expect(reads().timeline).toBe(after.timeline);
    expect(after.state).toBe("unregistered");
    await stopAll(alice);
  });
});
