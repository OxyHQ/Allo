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

describe("polls, pins, places and cards", () => {
  const ref = (eventId: string) => ({ kind: "event" as const, conversationId: "c", eventId });

  it("counts an account once, lets the last vote replace the one before it, and an empty vote retract", () => {
    const poll = ev({
      id: "p1",
      seq: 1,
      senderAccountId: "me",
      message: { v: 1, t: "poll", question: "Thursday?", options: [{ id: "o1", label: "Morning" }, { id: "o2", label: "Evening" }], multiple: true, anonymous: false },
    });
    const events: EventRecord[] = [
      poll,
      ev({ id: "v1", seq: 2, senderAccountId: "them", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: ["o1"] } }),
      // the same voter again: this REPLACES their answer rather than adding to it
      ev({ id: "v2", seq: 3, senderAccountId: "them", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: ["o1", "o2"] } }),
      ev({ id: "v3", seq: 4, senderAccountId: "me", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: ["o2"] } }),
      // an option nobody published: dropped, not counted
      ev({ id: "v4", seq: 5, senderAccountId: "third", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: ["o9"] } }),
    ];
    const [item] = project({ conversationId: "c", events, outbox: [], accountId: "me", instanceId: "i" });
    if (item.content.kind !== "poll") throw new Error("expected a poll");
    const { poll: view } = item.content;
    expect(view.options.map((o) => [o.id, o.votes, o.mine])).toEqual([
      ["o1", 1, false],
      ["o2", 2, true],
    ]);
    // three accounts answered; "third" chose nothing this client knows, and still counts as having answered
    expect(view.totalVotes).toBe(3);
    expect(view.voted).toBe(true);
    expect(view.options[1].accountIds.sort()).toEqual(["me", "them"]);

    const retracted = project({
      conversationId: "c",
      events: [...events, ev({ id: "v5", seq: 6, senderAccountId: "me", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: [] } })],
      outbox: [],
      accountId: "me",
      instanceId: "i",
    })[0];
    if (retracted.content.kind !== "poll") throw new Error("expected a poll");
    expect(retracted.content.poll.voted).toBe(false);
    expect(retracted.content.poll.options[1].votes).toBe(1);
  });

  it("names nobody on a poll that asked for anonymity, while still counting the answers", () => {
    const events: EventRecord[] = [
      ev({ id: "p1", seq: 1, senderAccountId: "me", message: { v: 1, t: "poll", question: "Where?", options: [{ id: "o1", label: "Canal" }, { id: "o2", label: "Park" }], multiple: false, anonymous: true } }),
      ev({ id: "v1", seq: 2, senderAccountId: "them", message: { v: 1, t: "poll_vote", target: ref("p1"), optionIds: ["o1"] } }),
    ];
    const [item] = project({ conversationId: "c", events, outbox: [], accountId: "me", instanceId: "i" });
    if (item.content.kind !== "poll") throw new Error("expected a poll");
    expect(item.content.poll.options[0].votes).toBe(1);
    expect(item.content.poll.options[0].accountIds).toEqual([]);
  });

  it("folds the last pin op per target, from anybody in the conversation", () => {
    const events: EventRecord[] = [
      ev({ id: "e1", seq: 1, senderAccountId: "me", message: { v: 1, t: "text", body: "the address" } }),
      ev({ id: "e2", seq: 2, senderAccountId: "them", message: { v: 1, t: "pin", target: ref("e1"), op: "pin" } }),
    ];
    expect(project({ conversationId: "c", events, outbox: [], accountId: "me", instanceId: "i" })[0].pinned).toBe(true);
    const unpinned = project({
      conversationId: "c",
      events: [...events, ev({ id: "e3", seq: 3, senderAccountId: "me", message: { v: 1, t: "pin", target: ref("e1"), op: "unpin" } })],
      outbox: [],
      accountId: "me",
      instanceId: "i",
    })[0];
    expect(unpinned.pinned).toBeUndefined();
  });

  it("carries a place and a card through as themselves", () => {
    const events: EventRecord[] = [
      ev({ id: "e1", seq: 1, senderAccountId: "them", message: { v: 1, t: "location", latitude: 52.37, longitude: 4.89, label: "The canal" } }),
      ev({ id: "e2", seq: 2, senderAccountId: "them", message: { v: 1, t: "contact", name: "Teodor Ilic", handle: "teodor", accountId: "acc-teodor" } }),
    ];
    const [place, card] = project({ conversationId: "c", events, outbox: [], accountId: "me", instanceId: "i" });
    expect(place.content).toEqual({ kind: "location", place: { latitude: 52.37, longitude: 4.89, label: "The canal", address: undefined } });
    expect(card.content).toEqual({ kind: "contact", contact: { name: "Teodor Ilic", handle: "teodor", accountId: "acc-teodor", phone: undefined } });
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
