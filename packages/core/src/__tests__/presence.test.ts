/**
 * Presence over the fake server: the client half of ADR 0002's third
 * decision. The rules themselves are the backend's and are tested there; what
 * is tested here is that the SDK asks the way the contract says, folds the
 * answers, and forgets them when it should.
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, waitFor, waitJoined } from "./e2eHelpers";

describe("presence", () => {
  it("watches a set, sees somebody arrive, and sees them go", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    await alice.client.presence.watch(["acc-bob-0001"]);
    // Bob's client is started, so his socket is attached and beating.
    await waitFor(() => alice.client.presence.of("acc-bob-0001").online);
    expect(alice.client.presence.of("acc-bob-0001").lastSeenAt).toBeNull();

    await bob.client.stop();
    await waitFor(() => !alice.client.presence.of("acc-bob-0001").online);
    const gone = alice.client.presence.of("acc-bob-0001");
    expect(gone.known).toBe(true);
    expect(gone.lastSeenAt).not.toBeNull();
    // Published truncated to the minute.
    expect(gone.lastSeenAt!.endsWith(":00.000Z")).toBe(true);

    await stopAll(alice);
  });

  it("an account it shares no conversation with reads as offline, never as an error", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const stranger = await makeClient(server, "acc-stranger1", "Stranger", "web");

    await alice.client.presence.watch(["acc-stranger1"]);
    await waitFor(() => alice.client.presence.of("acc-stranger1").known);
    expect(alice.client.presence.of("acc-stranger1")).toMatchObject({ online: false, lastSeenAt: null });

    await stopAll(alice, stranger);
  });

  it("an account that hides its own presence is told it publishes nothing, and sees nobody", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    server.presenceHidden.add("acc-alice-01");
    await alice.client.presence.watch(["acc-bob-0001"]);
    await waitFor(() => alice.client.presence.of("acc-bob-0001").known);

    expect(alice.client.presence.publishing()).toBe(false);
    expect(alice.client.presence.of("acc-bob-0001").online).toBe(false);

    await stopAll(alice, bob);
  });

  it("a block reads exactly like being offline, from both sides", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    server.blocks.add("acc-alice-01:acc-bob-0001");
    await alice.client.presence.watch(["acc-bob-0001"]);
    await bob.client.presence.watch(["acc-alice-01"]);
    await waitFor(() => alice.client.presence.of("acc-bob-0001").known && bob.client.presence.of("acc-alice-01").known);

    expect(alice.client.presence.of("acc-bob-0001")).toMatchObject({ online: false, lastSeenAt: null });
    expect(bob.client.presence.of("acc-alice-01")).toMatchObject({ online: false, lastSeenAt: null });

    await stopAll(alice, bob);
  });

  it("forgets an account the moment it stops being watched, and is empty on an unstarted client", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob", "ios");
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    await alice.client.presence.watch(["acc-bob-0001"]);
    await waitFor(() => alice.client.presence.of("acc-bob-0001").online);

    await alice.client.presence.watch([]);
    expect(alice.client.presence.of("acc-bob-0001").known).toBe(false);

    await stopAll(alice, bob);

    // A stopped client answers the same frozen nothing, rather than a dot it
    // cannot stand behind.
    const stopped = alice.client.presence.of("acc-bob-0001");
    expect(stopped).toEqual({ online: false, lastSeenAt: null, known: false });
    expect(alice.client.presence.of("acc-bob-0001")).toBe(stopped);
  });

  it("never watches itself: a client's own dot is not something to ask about", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice", "web");
    await alice.client.presence.watch(["acc-alice-01"]);
    expect(alice.client.presence.of("acc-alice-01").known).toBe(false);
    await stopAll(alice);
  });
});
