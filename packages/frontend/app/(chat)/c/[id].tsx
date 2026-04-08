import React, { useMemo, useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import ConversationView from "@/components/conversation/ConversationView";
import { useConversationsStore } from "@/stores";
import { useOxy } from "@oxyhq/services";
import { useUserById, useUsersStore } from "@/stores/usersStore";
import { api } from "@/utils/api";
import { toast } from "@/lib/sonner";

/**
 * Unified route handler for ALL conversations: /c/:id
 *
 * This route handles both:
 * 1. Direct conversations (when id is a userId)
 * 2. Group/channel conversations (when id is a conversationId)
 *
 * It automatically detects which type based on:
 * - If a conversation with this ID exists → use it directly
 * - If not, treat it as a userId and find/create a direct conversation
 *
 * Offline-first: renders ConversationView immediately using an optimistic
 * conversation when needed, so the user never sees a loading spinner.
 */
export default function UnifiedConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  const { user: currentUser } = useOxy();
  const conversations = useConversationsStore((state) => state.conversations);
  const conversationsById = useConversationsStore((state) => state.conversationsById);
  const addConversation = useConversationsStore((state) => state.addConversation);
  const ensureById = useUsersStore((state) => state.ensureById);
  const oxyServices = useOxy().oxyServices;

  // Check if this ID is an existing conversation
  const existingConversationById = conversationsById[id || ""];

  // If not found as conversation ID, try to find as userId (direct conversation)
  const existingDirectConversation = useMemo(() => {
    if (existingConversationById || !id || !currentUser?.id) return null;

    const directConv = conversations.find((conv) => {
      if (conv.type !== "direct") return false;
      const otherParticipant = conv.participants?.find(
        (p) => p.id !== currentUser.id
      );
      return otherParticipant?.id === id;
    });

    return directConv || null;
  }, [conversations, id, currentUser?.id, existingConversationById]);

  // Determine if we're treating this as a userId or conversationId
  const isUserId = !existingConversationById && id;
  const targetUserId = isUserId ? id : null;

  // Get user by ID (only if treating as userId)
  const targetUser = useUserById(targetUserId);

  // Ensure user is loaded in store (only if treating as userId)
  useEffect(() => {
    if (targetUserId && oxyServices) {
      ensureById(targetUserId, (id) => oxyServices.getUserById(id));
    }
  }, [targetUserId, ensureById, oxyServices]);

  // Build an optimistic conversation ID for direct conversations
  const optimisticId = useMemo(() => {
    if (!isUserId || !targetUserId || !currentUser?.id) return null;
    const sorted = [targetUserId, currentUser.id].sort();
    return `optimistic-dm-${sorted[0]}-${sorted[1]}`;
  }, [isUserId, targetUserId, currentUser?.id]);

  // Add optimistic conversation to store if treating as userId and none exists
  const addedOptimistic = useRef(false);
  useEffect(() => {
    if (
      !isUserId ||
      existingDirectConversation ||
      !optimisticId ||
      !targetUserId ||
      !currentUser?.id ||
      addedOptimistic.current
    )
      return;

    // Only add optimistic if it doesn't exist yet
    const store = useConversationsStore.getState();
    if (store.conversationsById[optimisticId]) return;

    const displayName = targetUser
      ? (typeof targetUser.name === "string"
          ? targetUser.name
          : targetUser.name?.first
            ? `${targetUser.name.first} ${targetUser.name?.last || ""}`.trim()
            : targetUser.username || "Chat")
      : "Chat";

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
          id: targetUserId,
          name: {
            first: displayName.split(" ")[0],
            last: displayName.split(" ").slice(1).join(" "),
          },
          username: targetUser?.username,
          avatar: targetUser?.avatar,
        },
      ],
      participantCount: 2,
    });
    addedOptimistic.current = true;
  }, [
    isUserId,
    existingDirectConversation,
    optimisticId,
    targetUserId,
    currentUser?.id,
    targetUser,
    addConversation,
  ]);

  // Create real conversation in the background (only for direct conversations)
  const creatingRef = useRef(false);
  useEffect(() => {
    if (
      !isUserId ||
      !targetUserId ||
      !currentUser?.id ||
      existingDirectConversation ||
      creatingRef.current
    )
      return;

    creatingRef.current = true;

    (async () => {
      try {
        const response = await api.post<any>("/conversations", {
          type: "direct",
          participantIds: [targetUserId],
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
        console.error("[ConversationRoute] Error creating conversation:", error);
        toast.error("Failed to create conversation");
      }
    })();
  }, [
    isUserId,
    targetUserId,
    currentUser?.id,
    existingDirectConversation,
    addConversation,
    optimisticId,
  ]);

  // Determine final conversation ID to render
  const conversationId =
    existingConversationById?.id ||
    existingDirectConversation?.id ||
    optimisticId;

  return <ConversationView conversationId={conversationId || undefined} />;
}
