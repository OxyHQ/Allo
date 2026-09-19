import { useMemo } from 'react';
import { useConversations, usePresence } from '@allo/react';
import type { ChatSummary } from '@oxy.so/bloom/chat-list';

import { chatSummary } from '@/lib/chat/model';
import { useChatContext } from '@/hooks/useChatContext';
import { presenceDot } from '@/lib/presence';

/**
 * How many DM counterparties the list watches.
 *
 * The list is the app's one place where a watch set could quietly become the
 * address book. A cap keeps it a screen: the rows below it are drawn without a
 * dot until they are scrolled to, which is the same thing the server's own cap
 * would do, only politer.
 */
const WATCH_LIMIT = 40;

/** Every conversation as a list row, most recent first, with a dot on the DMs that are online. */
export function useChatSummaries(): ChatSummary[] {
  const views = useConversations();
  const memberIds = useMemo(() => [...new Set(views.flatMap((view) => view.memberAccountIds))], [views]);
  const ctx = useChatContext(memberIds);

  // Only DMs: a group row has several people behind it and one dot cannot
  // speak for them.
  const counterparties = useMemo(
    () =>
      views
        .filter((view) => view.kind === 'dm')
        .map((view) => view.memberAccountIds.find((id) => id !== ctx.me))
        .filter((id): id is string => Boolean(id))
        .slice(0, WATCH_LIMIT),
    [views, ctx.me],
  );
  const presence = usePresence(counterparties);

  return useMemo(
    () =>
      views.map((view) => {
        const summary = chatSummary(view, ctx);
        if (view.kind !== 'dm') return summary;
        const other = view.memberAccountIds.find((id) => id !== ctx.me);
        const dot = other ? presenceDot(presence.of(other)) : undefined;
        return dot ? { ...summary, presence: dot } : summary;
      }),
    [views, ctx, presence],
  );
}
