/**
 * DELETING A CONVERSATION, on this device and — if asked — on theirs.
 *
 * The local half is a real delete: the event rows go. The remote half is a
 * `clear_history` control message their client obeys, which is the most an
 * end-to-end encrypted system can honestly offer, because the other copy sits
 * on the other person's device under keys only they hold.
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, texts, waitFor, waitForText } from "./e2eHelpers";

describe("deleting a conversation", () => {
  it("deletes only my copy by default, and hides it until somebody speaks again", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-clear-a", "Alice");
    const bob = await makeClient(server, "acc-clear-b", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.messages.send(conversation.id, "one");
    await alice.client.sync.flush();
    await waitForText(bob, conversation.id, "one");

    await alice.client.messages.clearHistory(conversation.id);
    expect(alice.client.messages.timeline(conversation.id)).toEqual([]);
    // Out of the list, but not out of existence: the membership is the server's.
    expect(alice.client.conversations.list().map((c) => c.id)).not.toContain(conversation.id);
    expect(alice.client.conversations.get(conversation.id)).toBeDefined();

    // Bob keeps his: nothing was asked of him.
    expect(texts(bob.client.messages.timeline(conversation.id))).toContain("one");

    // And it comes back the moment he says something.
    await bob.client.messages.send(conversation.id, "still here?");
    await bob.client.sync.flush();
    await waitForText(alice, conversation.id, "still here?");
    expect(alice.client.conversations.list().map((c) => c.id)).toContain(conversation.id);
    // Only what came after the line: the deleted message does not return.
    expect(texts(alice.client.messages.timeline(conversation.id))).toEqual(["still here?"]);
    await stopAll(alice, bob);
  }, 30_000);

  it("asks the other side too when told to, and does not swallow a message that crossed it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-clear-c", "Alice");
    const bob = await makeClient(server, "acc-clear-d", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.messages.send(conversation.id, "delete me");
    await alice.client.sync.flush();
    await waitForText(bob, conversation.id, "delete me");

    await alice.client.messages.clearHistory(conversation.id, { forEveryone: true });
    await alice.client.sync.flush();

    // Bob's client obeys the request.
    await waitFor(() => bob.client.messages.timeline(conversation.id).length === 0);
    expect(texts(bob.client.messages.timeline(conversation.id))).toEqual([]);

    // What comes afterwards is untouched on both sides.
    await bob.client.messages.send(conversation.id, "after the wipe");
    await bob.client.sync.flush();
    await waitForText(alice, conversation.id, "after the wipe");
    expect(texts(alice.client.messages.timeline(conversation.id))).toEqual(["after the wipe"]);
    await stopAll(alice, bob);
  }, 30_000);

  it("does not let its own echo swallow what was said after it", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-clear-e", "Alice");
    const bob = await makeClient(server, "acc-clear-f", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.messages.send(conversation.id, "one");
    await alice.client.sync.flush();

    // The local wipe happens immediately; the `clear_history` event comes back
    // through sync a moment later carrying a LOWER line. The guard is what
    // stops that echo taking the next message with it.
    await alice.client.messages.clearHistory(conversation.id, { forEveryone: true });
    await alice.client.messages.send(conversation.id, "two");
    await alice.client.sync.flush();
    await waitForText(bob, conversation.id, "two");
    await alice.client.sync.now();

    expect(texts(alice.client.messages.timeline(conversation.id))).toEqual(["two"]);
    expect(texts(bob.client.messages.timeline(conversation.id))).toEqual(["two"]);
    await stopAll(alice, bob);
  }, 30_000);
});
