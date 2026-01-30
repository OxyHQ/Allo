import React, { useMemo, useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import ConversationView from "@/components/conversation/ConversationView";
import { useConversationsStore } from "@/stores";
import { useOxy } from "@oxyhq/services";
import { useUserById, useUsersStore } from "@/stores/usersStore";
import { api } from "@/utils/api";
import { toast } from "@/lib/sonner";

/**
 * Route handler for /u/:id direct conversations
 * This route is used for direct conversations with specific users
 * It finds or creates the conversation and displays it
 *
 * Offline-first: renders ConversationView immediately using an optimistic
 * conversation when no existing one is found, so the user never sees a
 * loading spinner. The real conversation is created in the background.
 */
export default function UserConversationRoute() {
  const { id: userId } = useLocalSearchParams<{ id: string }>();

  const { user: currentUser } = useOxy();
  const conversations = useConversationsStore((state) => state.conversations);
  const addConversation = useConversationsStore((state) => state.addConversation);
  const ensureById = useUsersStore((state) => state.ensureById);
  const oxyServices = useOxy().oxyServices;

  // Get user by ID
  const targetUser = useUserById(userId);

  // Ensure user is loaded in store
  useEffect(() => {
    if (userId && oxyServices) {
      ensureById(userId, (id) => oxyServices.getProfileByUsername(id));
    }
  }, [userId, ensureById, oxyServices]);

  // Find existing direct conversation with this user
  const existingConversation = useMemo(() => {
    if (!userId || !currentUser?.id) return null;

    const directConv = conversations.find((conv) => {
      if (conv.type !== "direct") return false;
      const otherParticipant = conv.participants?.find(
        (p) => p.id !== currentUser.id
      );
      return otherParticipant?.id === userId;
    });

    return directConv || null;
  }, [conversations, userId, currentUser?.id]);

  // Build an optimistic conversation ID so we can render immediately
  const optimisticId = useMemo(() => {
    if (!userId || !currentUser?.id) return null;
    // Deterministic temp ID based on participants
    const sorted = [userId, currentUser.id].sort();
    return `optimistic-dm-${sorted[0]}-${sorted[1]}`;
  }, [userId, currentUser?.id]);

  // Add optimistic conversation to store if none exists yet
  const addedOptimistic = useRef(false);
  useEffect(() => {
    if (existingConversation || !optimisticId || !userId || !currentUser?.id || addedOptimistic.current) return;

    // Only add optimistic if it doesn't exist yet
    const store = useConversationsStore.getState();
    if (store.conversationsById[optimisticId]) return;

    const displayName = targetUser
      ? (typeof targetUser.name === 'string'
          ? targetUser.name
          : targetUser.name?.first
            ? `${targetUser.name.first} ${targetUser.name?.last || ''}`.trim()
            : targetUser.username || 'Chat')
      : 'Chat';

    addConversation({
      id: optimisticId,
      type: "direct",
      name: displayName,
      lastMessage: "",
      timestamp: new Date().toISOString(),
      unreadCount: 0,
      avatar: targetUser?.avatar,
      participants: [
        {
          id: userId,
          name: { first: displayName.split(' ')[0], last: displayName.split(' ').slice(1).join(' ') },
          username: targetUser?.username,
          avatar: targetUser?.avatar,
        },
      ],
      participantCount: 2,
    });
    addedOptimistic.current = true;
  }, [existingConversation, optimisticId, userId, currentUser?.id, targetUser, addConversation]);

  // Create real conversation in the background
  const creatingRef = useRef(false);
  useEffect(() => {
    if (!userId || !currentUser?.id || existingConversation || creatingRef.current) return;
    // Don't create if we already have a real (non-optimistic) conversation
    if (existingConversation) return;

    creatingRef.current = true;

    (async () => {
      try {
        const response = await api.post<any>("/conversations", {
          type: "direct",
          participantIds: [userId],
        });

        const apiConversation = response.data.data || response.data;
        const participants = (apiConversation.participants || []).map(
          (p: any) => ({
            id: p.userId,
            name: {
              first: p.name?.first || "Unknown",
              last: p.name?.last || "",
            },
            username: p.username,
            avatar: p.avatar,
          })
        );

        const conversation = {
          id: apiConversation._id || apiConversation.id,
          type: "direct" as const,
          name: apiConversation.name || "Direct Chat",
          lastMessage: "",
          timestamp: new Date(apiConversation.createdAt).toISOString(),
          unreadCount: 0,
          avatar: apiConversation.avatar,
          participants,
          groupName: apiConversation.name,
          groupAvatar: apiConversation.avatar,
          participantCount: participants.length,
        };

        // Remove optimistic and add real conversation
        if (optimisticId) {
          useConversationsStore.getState().removeConversation(optimisticId);
        }
        addConversation(conversation);
      } catch (error: any) {
        console.error("[UserRoute] Error creating conversation:", error);
        toast.error("Failed to create conversation");
      }
    })();
  }, [userId, currentUser?.id, existingConversation, addConversation, optimisticId]);

  // Always render ConversationView immediately — either with the real or optimistic conversation
  const conversationId = existingConversation?.id || optimisticId;

  return <ConversationView conversationId={conversationId || undefined} />;
}
