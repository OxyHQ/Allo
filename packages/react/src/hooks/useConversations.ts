import type { ConversationView } from "@allo/core";
import { useCallback, useMemo } from "react";
import { useAlloContext } from "../AlloProvider";
import { useClientSnapshot, useClientSnapshotOf } from "../internal/useClientSnapshot";

/** Every conversation this account is in, most recent activity first. Subscribes to `conversations`. */
export function useConversations(): ConversationView[] {
  const { client } = useAlloContext();
  return useClientSnapshot(client, "conversations", () => client.conversations.list());
}

/** One conversation, or `undefined` while unknown. Subscribes to `conversations`. */
export function useConversation(conversationId: string): ConversationView | undefined {
  const { client } = useAlloContext();
  return useClientSnapshot(client, "conversations", () => client.conversations.get(conversationId));
}

/** Unread count of one conversation, computed locally. Subscribes to `conversations` and its timeline. */
export function useUnreadCount(conversationId: string): number {
  const { client } = useAlloContext();
  const topics = useMemo(() => ["conversations", `timeline:${conversationId}`] as const, [conversationId]);
  return useClientSnapshotOf(client, topics, () => client.messages.unreadCount(conversationId));
}

/** The sum of every conversation's unread count. Subscribes to `conversations`. */
export function useTotalUnread(): number {
  const { client } = useAlloContext();
  return useClientSnapshot(client, "conversations", () => client.conversations.list().reduce((n, c) => n + c.unreadCount, 0));
}

export interface ConversationActions {
  createDirect(accountId: string): Promise<ConversationView>;
  createGroup(memberAccountIds: string[]): Promise<ConversationView>;
  addMember(conversationId: string, accountId: string): Promise<void>;
  removeMember(conversationId: string, accountId: string): Promise<void>;
  leave(conversationId: string): Promise<void>;
  rename(conversationId: string, name: string): Promise<void>;
  /** Re-pulls the server's conversation list. */
  refresh(): Promise<void>;
}

/** Stable action functions. Each returns the client's promise; errors surface to the caller. */
export function useConversationActions(): ConversationActions {
  const { client } = useAlloContext();
  const createDirect = useCallback((accountId: string) => client.conversations.createDirect(accountId), [client]);
  const createGroup = useCallback((memberAccountIds: string[]) => client.conversations.createGroup(memberAccountIds), [client]);
  const addMember = useCallback((conversationId: string, accountId: string) => client.conversations.addMember(conversationId, accountId), [client]);
  const removeMember = useCallback((conversationId: string, accountId: string) => client.conversations.removeMember(conversationId, accountId), [client]);
  const leave = useCallback((conversationId: string) => client.conversations.leave(conversationId), [client]);
  const rename = useCallback((conversationId: string, name: string) => client.conversations.rename(conversationId, name), [client]);
  const refresh = useCallback(() => client.conversations.refresh(), [client]);
  return useMemo(
    () => ({ createDirect, createGroup, addMember, removeMember, leave, rename, refresh }),
    [createDirect, createGroup, addMember, removeMember, leave, rename, refresh],
  );
}
