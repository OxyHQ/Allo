import React from 'react';
import { useLocalSearchParams } from 'expo-router';
import ConversationView from '@/components/conversation/ConversationView';

/**
 * Route handler for /c/:id channel/group conversations
 * This route is used for channel and group conversations
 */
export default function ChannelConversationRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();

  return <ConversationView conversationId={id} />;
}
