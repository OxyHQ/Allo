import { useMemo } from 'react';
import { useConversations } from '@allo/react';
import type { ChatSummary } from '@oxy.so/bloom/chat-list';

import { chatSummary } from '@/lib/chat/model';
import { useChatContext } from '@/hooks/useChatContext';

/** Every conversation as a list row, most recent first. */
export function useChatSummaries(): ChatSummary[] {
  const views = useConversations();
  const memberIds = useMemo(() => [...new Set(views.flatMap((view) => view.memberAccountIds))], [views]);
  const ctx = useChatContext(memberIds);
  return useMemo(() => views.map((view) => chatSummary(view, ctx)), [views, ctx]);
}
