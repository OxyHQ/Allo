import React, { useMemo, useEffect } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { View, Text } from 'react-native';
import ConversationView from '../c/[id]';
import { useConversationsStore } from '@/stores';
import { useOxy } from '@oxyhq/services';
import { useUserById, useUsersStore } from '@/stores/usersStore';
import { api } from '@/utils/api';
import { toast } from '@/lib/sonner';

/**
 * Route handler for /u/:id direct conversations
 * This route is used for direct conversations between users
 * It finds or creates the conversation and redirects to the conversation view
 */
export default function UserConversationRoute({ userId: propUserId }: { userId?: string }) {
  const { id: paramUserId } = useLocalSearchParams<{ id: string }>();
  const userId = propUserId || paramUserId;

  const { user: currentUser, oxyServices } = useOxy();
  const conversations = useConversationsStore((state) => state.conversations);
  const addConversation = useConversationsStore((state) => state.addConversation);
  const ensureById = useUsersStore((state) => state.ensureById);
  const router = useRouter();

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

    // First, try to find in existing conversations
    const directConv = conversations.find((conv) => {
      if (conv.type !== 'direct') return false;

      // Check if the other participant matches the user ID
      const otherParticipant = conv.participants?.find(p => p.id !== currentUser.id);
      if (!otherParticipant) return false;

      return otherParticipant.id === userId;
    });

    return directConv || null;
  }, [conversations, userId, currentUser?.id]);

  // If conversation exists, use it
  if (existingConversation) {
    return <ConversationView conversationId={existingConversation.id} />;
  }

  // If user found but no conversation exists, create it
  useEffect(() => {
    const createDirectConversation = async () => {
      if (!userId || !currentUser?.id || existingConversation) return;

      try {
        const response = await api.post<any>('/conversations', {
          type: 'direct',
          participantIds: [userId],
        });

        const apiConversation = response.data.data || response.data;
        const participants = (apiConversation.participants || []).map((p: any) => ({
          id: p.userId,
          name: {
            first: p.name?.first || 'Unknown',
            last: p.name?.last || '',
          },
          username: p.username,
          avatar: p.avatar,
        }));

        const conversation = {
          id: apiConversation._id || apiConversation.id,
          type: 'direct',
          name: apiConversation.name || 'Direct Chat',
          lastMessage: '',
          timestamp: new Date(apiConversation.createdAt).toISOString(),
          unreadCount: 0,
          avatar: apiConversation.avatar,
          participants,
          groupName: apiConversation.name,
          groupAvatar: apiConversation.avatar,
          participantCount: participants.length,
        };

        addConversation(conversation);
      } catch (error: any) {
        console.error('[UserRoute] Error creating conversation:', error);
        toast.error('Failed to create conversation');
      }
    };

    if (userId && !existingConversation) {
      createDirectConversation();
    }
  }, [userId, currentUser, existingConversation, addConversation, router]);

  // Show conversation view if it exists, otherwise show loading
  if (existingConversation) {
    return <ConversationView conversationId={existingConversation.id} />;
  }

  // Loading state - wait for conversation to be created
  return null;
}

