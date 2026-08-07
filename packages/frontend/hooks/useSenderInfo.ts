import { useCallback, useEffect } from 'react';
import { useUsersStore } from '@/stores/usersStore';
import { useOxy } from '@oxyhq/services';
import { Conversation } from '@/app/(chat)/index';
import type { SenderInfo } from '@/hooks/useMatrixSenderInfo';
import { logger } from '@/utils/logger';

/**
 * Who sent each message, on the Express backend.
 *
 * Every id here is an **Oxy account id**. `useMatrixSenderInfo` is the other
 * half, for the backend where they are Matrix user ids, and the two answer the
 * same {@link SenderInfo} shape so that `ConversationView` picks between them
 * with a `??` and nothing else changes.
 */
export function useSenderInfo(
  conversation: Conversation | null | undefined,
  isGroup: boolean,
  conversationMetadata: { contactAvatar?: string }
): SenderInfo {
  const usersStore = useUsersStore();
  const { user, oxyServices } = useOxy();

  // Ensure we have user data for all participants
  useEffect(() => {
    if (conversation?.participants) {
      conversation.participants.forEach((p) => {
        if (p.id && p.id !== user?.id) {
          // `getUserById`, not `getProfileByUsername`. A participant id is an
          // Oxy account id, and the by-username endpoint 404s on one — which it
          // did, once per participant per render, in production.
          usersStore.ensureById(p.id, (id) => oxyServices.getUserById(id));
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
        return senderUser.name;
      }
      if (senderUser.name?.displayName) {
        return senderUser.name.displayName;
      }
      if (senderUser.username || senderUser.handle) {
        return senderUser.username || senderUser.handle;
      }
    }

    // 2. If it's the current user, use current user data
    if (senderId === user?.id) {
      return user.name?.displayName || user.username;
    }

    // 3. Fallback to participant data
    const participant = conversation?.participants?.find(p => p.id === senderId);
    if (participant?.name?.displayName) {
      return participant.name.displayName;
    }

    // 4. Fallback to participant username or senderId
    return participant?.username || '';
  }, [conversation, user, usersStore]);

  /**
   * The sender's handle, without its `@`.
   *
   * Drawn by `MessageInfoScreen`, where the line used to be the raw account id.
   */
  const getSenderHandle = useCallback((senderId: string): string | undefined => {
    const senderUser = usersStore.getCachedById(senderId);
    if (senderUser?.username || senderUser?.handle) {
      return senderUser.username || senderUser.handle;
    }
    if (senderId === user?.id) {
      return user.username;
    }
    return conversation?.participants?.find((p) => p.id === senderId)?.username;
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
      } catch (error: unknown) {
        // The id is kept and handed on: an image that fails to load is a missing
        // face, and swallowing the reason leaves nothing to explain it by.
        logger.error(`[chat] no avatar URL could be built for ${senderId}`, error);
      }
    }

    return avatar;
  }, [conversation, conversationMetadata.contactAvatar, isGroup, usersStore, oxyServices]);

  return { getSenderName, getSenderHandle, getSenderAvatar };
}
