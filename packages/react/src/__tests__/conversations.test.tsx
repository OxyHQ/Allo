import { act, waitFor as rtlWaitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useConversationActions, useConversations, useTotalUnread, useUnreadCount } from "../index";
import { fakeServer, makeClient, renderAlloHook, stopAll, waitJoined, type TestClient } from "./helpers";

describe("useConversations", () => {
  const started: TestClient[] = [];
  afterEach(async () => {
    await stopAll(...started.splice(0));
  });

  it("updates when a DM is created and when a message arrives from the other party", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);

    const { result } = renderAlloHook(alice.client, () => ({ conversations: useConversations(), actions: useConversationActions(), total: useTotalUnread() }));
    expect(result.current.conversations).toEqual([]);
    expect(result.current.total).toBe(0);

    let conversationId = "";
    await act(async () => {
      const conv = await result.current.actions.createDirect("acc-bob-0001");
      conversationId = conv.id;
    });
    await rtlWaitFor(() => expect(result.current.conversations.map((c) => c.id)).toEqual([conversationId]));
    expect(result.current.conversations[0].kind).toBe("dm");
    expect(result.current.conversations[0].memberAccountIds).toContain("acc-bob-0001");
    await waitJoined(bob, conversationId);

    await bob.client.messages.send(conversationId, "hello from bob");
    await rtlWaitFor(() => {
      const last = result.current.conversations[0]?.lastMessage;
      expect(last?.content).toEqual({ kind: "text", body: "hello from bob", isEdited: false });
    });
    expect(result.current.conversations[0].unreadCount).toBe(1);
    expect(result.current.total).toBe(1);
  });

  it("useUnreadCount follows incoming messages and markRead", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    const bob = await makeClient(server, "acc-bob-0001", "Bob iOS", "ios");
    started.push(alice, bob);
    const conv = await alice.client.conversations.createDirect("acc-bob-0001");
    await waitJoined(bob, conv.id);

    const { result } = renderAlloHook(bob.client, () => useUnreadCount(conv.id));
    expect(result.current).toBe(0);
    await alice.client.messages.send(conv.id, "one");
    await alice.client.messages.send(conv.id, "two");
    await rtlWaitFor(() => expect(result.current).toBe(2));
    await act(async () => {
      await bob.client.messages.markRead(conv.id);
    });
    await rtlWaitFor(() => expect(result.current).toBe(0));
  });

  it("action functions are referentially stable across renders", async () => {
    const server = fakeServer();
    const alice = await makeClient(server, "acc-alice-01", "Alice web");
    started.push(alice);
    const { result, rerender } = renderAlloHook(alice.client, () => useConversationActions());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    expect(result.current.createDirect).toBe(first.createDirect);
  });
});
