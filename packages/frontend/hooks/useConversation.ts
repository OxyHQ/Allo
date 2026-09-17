import { useMemo } from 'react';
import { useConversation as useAlloConversation } from '@allo/react';

import { conversationFromView, type Conversation } from '@/lib/chat/model';

/**
 * One conversation, as a screen draws it, or `null` while the SDK does not
 * know it. Subscribes to the SDK's `conversations` topic and re-projects when
 * it emits.
 *
 * `''` is passed for a missing id rather than skipping the hook: the SDK hook
 * takes a string, and hooks cannot be conditional.
 */
export function useConversation(conversationId?: string | null): Conversation | null {
  const view = useAlloConversation(conversationId ?? '');
  return useMemo(() => (view ? conversationFromView(view) : null), [view]);
}
