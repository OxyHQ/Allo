import { useScreenBack } from '@oxy.so/bloom/screen';
import { useLocalSearchParams } from 'expo-router';

import { ConversationInfo } from '@/components/chat/info/ConversationInfo';

/** `/c/:id/info` — a conversation's details as their own screen, on a phone. */
export default function ConversationInfoRoute() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const back = useScreenBack();
  return <ConversationInfo conversationId={id ?? ''} variant="screen" onClose={() => back?.()} />;
}
