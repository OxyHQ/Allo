import { useCallback, useEffect } from 'react';
import { useUsersStore } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';
import { Conversation } from '@/app/(chat)/index';

export function useSenderInfo(
  conversation: Conversation | null | undefined,
  isGroup: boolean,
  conversationMetadata: { contactAvatar?: string }
) {
  const usersStore = useUsersStore();
  const { user, oxyServices } = useOxy();

  // Ensure we have user data for all participants
  useEffect(() => {
    if (conversation?.participants) {
      conversation.participants.forEach((p) => {
        if (p.id && p.id !== user?.id) {
          // Try to fetch by ID (assuming getProfileByUsername handles IDs as per docs)
          usersStore.ensureById(p.id, (id) => oxyServices.getProfileByUsername(id));
        }
      });
    }
  }, [conversation?.participants, user?.id, usersStore, oxyServices]);

  /**
   * Get sender name for group conversations using Oxy user data
   */
  const getSenderName = useCallback((senderId: string): string | undefined => {
    // 1. Try to get from usersStore (Oxy user data) first - this is the priority
    const senderUser = usersStore.getCachedById(senderId);
    if (senderUser) {
      if (typeof senderUser.name === 'string') {
        return senderUser.name.split(' ')[0];
      }
      if (senderUser.name?.first) {
        return senderUser.name.first;
      }
      if (senderUser.username || senderUser.handle) {
        return senderUser.username || senderUser.handle;
      }
    }

    // 2. If it's the current user, use current user data
    if (senderId === user?.id) {
      if (typeof user.name === 'string') {
        return (user.name as string).split(' ')[0];
      }
      return user.name?.first || user.username;
    }

    // 3. Fallback to participant data
    const participant = conversation?.participants?.find(p => p.id === senderId);
    if (participant?.name?.first) {
      return participant.name.first;
    }

    // 4. Fallback to participant username or senderId
    return participant?.username || '';
  }, [conversation, user, usersStore]);

  /**
   * Get sender avatar for incoming messages using Oxy user data
   */
  const getSenderAvatar = useCallback((senderId: string): string | undefined => {
    if (!conversation) {
      return undefined;
    }

    let avatar: string | undefined;

    // 1. Try to get from usersStore (Oxy user data) first - this is the priority
    const user = usersStore.getCachedById(senderId);
    if (user?.avatar) {
      avatar = user.avatar;
    } else if (!isGroup) {
      // 2. Direct conversation: use contact avatar
      avatar = conversationMetadata.contactAvatar;
    } else {
      // 3. Fallback to participant data
      const participants = conversation.participants || [];
      const participant = participants.find(
        (p) => p.id === senderId || ('userId' in p && p.userId === senderId)
      );
      if (participant?.avatar) {
        avatar = participant.avatar;
      }
    }

    // Convert ID to URL if needed
    if (avatar && oxyServices && !avatar.startsWith('http') && !avatar.startsWith('file://')) {
      try {
        return oxyServices.getFileDownloadUrl(avatar, 'thumb');
      } catch (e) {
        // Ignore error
      }
    }

    return avatar;
  }, [conversation, conversationMetadata.contactAvatar, isGroup, usersStore, oxyServices]);

  return { getSenderName, getSenderAvatar };
}
