import React from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ConversationInfo } from '@/components/chat/info/ConversationInfo';

/** `/c/:id/info` — a conversation's details as their own screen, on a phone. */
export default function ConversationInfoRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  return <ConversationInfo conversationId={id ?? ''} variant="screen" onClose={() => router.back()} />;
}
