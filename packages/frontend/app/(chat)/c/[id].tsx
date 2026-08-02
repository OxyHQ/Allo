import React, { useMemo, useEffect, useRef } from "react";
import { useLocalSearchParams } from "expo-router";
import ConversationView from "@/components/conversation/ConversationView";
import { MatrixInvitationCard } from "@/components/matrix/MatrixInvitationCard";
import { useConversation } from "@/hooks/useConversation";
import { useConversationsStore } from "@/stores";
import { useOxy } from "@oxyhq/services";
import { useUserById, useUsersStore } from "@/stores/usersStore";
import { api } from "@/utils/api";
import { toast } from "@oxyhq/bloom/toast";
import { CHAT_BACKEND } from "@/lib/chat/backend";

/** Participant shape returned by the backend conversations API. */
interface ApiConversationParticipant {
  userId: string;
  username?: string;
  avatar?: string;
  name?: { displayName?: string; first?: string; last?: string };
}

/** Conversation shape returned by the backend conversations API. */
interface ApiConversation {
  _id?: string;
  id?: string;
  name?: string;
  createdAt?: string;
  avatar?: string;
  participants?: ApiConversationParticipant[];
}

/**
 * POST /conversations payload — the backend may return the conversation bare or
 * wrapped under a nested `data` key, so both shapes are accepted.
 */
type CreateConversationPayload = ApiConversation & { data?: ApiConversation };

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
function AlloApiConversationRoute() {
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
  const targetUser = useUserById(targetUserId ?? undefined);

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

    const targetName =
      targetUser && typeof targetUser.name !== "string" ? targetUser.name : undefined;
    const displayName =
      targetName?.displayName || targetUser?.username || "Chat";

    addConversation({
      id: optimisticId,
      type: "direct",
      name: displayName,
      lastMessage: "",
      timestamp: new Date().toISOString(),
      unreadCount: 0,
      // Cached `UserEntity.avatar` is nullable (mirrors the SDK); the local
      // Conversation shape uses `string | undefined`, so coerce `null` away.
      avatar: targetUser?.avatar ?? undefined,
      participants: [
        {
          id: targetUserId,
          name: {
            displayName,
            first: displayName.split(" ")[0],
            last: displayName.split(" ").slice(1).join(" "),
          },
          username: targetUser?.username,
          avatar: targetUser?.avatar ?? undefined,
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
        const response = await api.post<CreateConversationPayload>("/conversations", {
          type: "direct",
          participantIds: [targetUserId],
        });

        const apiConversation: ApiConversation = response.data.data || response.data;
        const participants = (apiConversation.participants || []).map(
          (p) => ({
            id: p.userId,
            name: {
              displayName: p.name?.displayName || p.username || "Unknown",
              first: p.name?.first || "",
              last: p.name?.last || "",
            },
            username: p.username,
            avatar: p.avatar,
          })
        );

        const conversation = {
          id: apiConversation._id || apiConversation.id || "",
          type: "direct" as const,
          name: apiConversation.name || "Direct Chat",
          lastMessage: "",
          timestamp: new Date(apiConversation.createdAt ?? Date.now()).toISOString(),
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
      } catch (error: unknown) {
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

/**
 * The same route, for a Matrix room.
 *
 * Everything the branch above does — resolving a user id, inventing an optimistic
 * conversation, creating one over the API — exists because Allo's own backend
 * makes a conversation out of a pair of user ids. On Matrix the id in the URL is
 * a room id and rooms come from sync alone: there is nothing to create here, and
 * a room that has not arrived yet is a room the timeline reports as empty rather
 * than one this route should conjure.
 *
 * The one thing it does branch on is an **invitation**, which is a room the
 * viewer has not joined: it has no readable timeline, and a composer over it
 * would send into a room this account is not in. That is how every group starts
 * for everybody who did not create it, so it is the difference between a family
 * group and a family group nobody else can use.
 */
function MatrixConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const conversation = useConversation(id);

  if (id && conversation?.isInvitation) {
    return <MatrixInvitationCard roomId={id} name={conversation.name} />;
  }
  return <ConversationView conversationId={id || undefined} />;
}

/**
 * Picks the route body for this build's chat backend.
 *
 * A component boundary and not a branch inside one body, because the two have
 * different hooks: React allows a component to be chosen conditionally, and does
 * not allow its hooks to be.
 */
export default function UnifiedConversationRoute() {
  return CHAT_BACKEND === 'matrix' ? <MatrixConversationRoute /> : <AlloApiConversationRoute />;
}
