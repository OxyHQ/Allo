import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, waitFor, waitForText, waitJoined } from "./e2eHelpers";

describe("outbox", () => {
  it("5xx then success yields one server event; the echo goes pending → accepted", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    server.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/events"), times: 2, status: 503, code: "unavailable" });
    const key = await alice.client.messages.send(conv.id, "resilient");
    expect(alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState).toBe("pending");
    await waitForText(bob, conv.id, "resilient", 15_000);
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState === "accepted");
    const posts = server.requestLog.filter((r) => r.method === "POST" && r.path.endsWith("/events") && r.instanceId === alice.client.instanceId);
    expect(posts.filter((p) => p.status === 503)).toHaveLength(2);
    expect(server.eventsOf(conv.id).filter((e) => e.kind === "app_message")).toHaveLength(1);
    expect(alice.client.messages.timeline(conv.id).filter((i) => i.content.kind === "text")).toHaveLength(1);
    await stopAll(alice, bob);
  });

  it("a 4xx that is not an epoch conflict marks the item failed", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);
    server.faults.push({ match: (m, p) => m === "POST" && p.endsWith("/events"), times: 1, status: 413, code: "payload_too_large" });
    const key = await alice.client.messages.send(conv.id, "too big");
    await waitFor(() => alice.client.messages.timeline(conv.id).find((i) => i.localKey === key)?.sendState === "failed");
    await stopAll(alice, bob);
  });
});
