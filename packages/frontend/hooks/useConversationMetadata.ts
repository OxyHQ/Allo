import { useMemo } from 'react';
import { Conversation } from '@/app/(chat)/index';
import { useOxy } from '@oxyhq/services';
import {
  useConversationDisplayName,
  getConversationAvatar,
  getGroupInfo,
  useContactInfo,
  isGroupConversation,
} from '@/utils/conversationUtils';

export function useConversationMetadata(
  conversation: Conversation | null | undefined,
  currentUserId?: string
) {
  const { oxyServices } = useOxy();
  const isGroup = useMemo(
    () => conversation ? isGroupConversation(conversation) : false,
    [conversation]
  );

  // Get contact info using Oxy hooks
  const contactInfo = useContactInfo(conversation ?? null, currentUserId);
  const groupInfo = getGroupInfo(conversation ?? null);

  // Reactive base name: recomputes when the participant user cache is enriched.
  const baseDisplayName = useConversationDisplayName(conversation, currentUserId);

  return useMemo(() => {
    let displayName = baseDisplayName;

    // Prefer contact name from Oxy data for direct chats
    if (!isGroup && contactInfo?.name) {
      displayName = contactInfo.name;
    }

    const avatar = conversation
      ? getConversationAvatar(conversation, currentUserId, oxyServices)
      : undefined;

    const participants = isGroup && conversation ? (conversation.participants || []) : [];

    return {
      contactInfo,
      groupInfo,
      displayName,
      avatar,
      participants,
      contactName: contactInfo?.name || groupInfo?.name || displayName,
      contactUsername: contactInfo?.username || undefined,
      contactAvatar: contactInfo?.avatar || groupInfo?.avatar || avatar,
      isOnline: contactInfo?.isOnline || false,
      isGroup,
    };
  }, [conversation, isGroup, contactInfo, groupInfo, currentUserId, baseDisplayName, oxyServices]);
}
