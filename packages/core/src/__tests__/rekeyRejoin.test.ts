/**
 * A RE-KEY MUST NOT LEAVE THE OTHER SIDE IN A ROOM OF ITS OWN.
 *
 * When a DM is re-keyed by the member who could not otherwise get into it
 * (`mayRekeyDirect`), whoever was offline still holds the OLD group state. A
 * Welcome for a conversation you are already in is normally a duplicate and
 * ignoring it is right — and doing that here left the two of them in separate
 * groups, each sending messages the other could not read, neither of them
 * told. Reported from the app as "This message could not be decrypted on this
 * device".
 */
import { describe, expect, it } from "vitest";
import { fakeServer, makeClient, stopAll, texts, waitFor, waitForText } from "./e2eHelpers";

/** After a re-key, does the side that was OFFLINE come back into the same conversation? */
describe("the other side after a re-key", () => {
  it("rejoins and can still talk", async () => {
    const server = fakeServer();
    server.keepGroupInfo = false;
    const alice = await makeClient(server, "acc-rj-a", "Alice phone");
    const bob = await makeClient(server, "acc-rj-b", "Bob");
    const conversation = await alice.client.conversations.createDirect(bob.accountId);
    await alice.client.messages.send(conversation.id, "before");
    await alice.client.sync.flush();
    await waitForText(bob, conversation.id, "before");

    // Bob goes away. Alice re-enrols and re-keys.
    await bob.client.stop();
    await alice.client.stop();
    server.instancesOf("acc-rj-a").forEach((i) => (i.status = "revoked"));
    const g = server.conversations.get(conversation.id)!;
    for (const [id, leaf] of g.leaves) if (leaf.accountId === "acc-rj-a") g.leaves.set(id, { ...leaf, state: "removed" });

    const alice2 = await makeClient(server, "acc-rj-a", "Alice laptop");
    await waitFor(() => alice2.client.conversations.get(conversation.id)?.joined === true, 10_000);
    await alice2.client.messages.send(conversation.id, "are you there");
    await alice2.client.sync.flush();

    // Bob comes back on the SAME device, holding the old group state.
    const bobAgain = await makeClient(server, "acc-rj-b", "Bob", "web", { storage: bob.storage, secrets: bob.secrets });
    await bobAgain.client.sync.now();
    await new Promise((r) => setTimeout(r, 500));
    await bobAgain.client.sync.now();

    expect(texts(bobAgain.client.messages.timeline(conversation.id))).toContain("are you there");

    await bobAgain.client.messages.send(conversation.id, "yes");
    await bobAgain.client.sync.flush();
    await waitForText(alice2, conversation.id, "yes");
    await stopAll(alice2, bobAgain);
  }, 40_000);
});
