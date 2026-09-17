import { useCallback } from 'react';

import { useOxy } from '@oxy.so/services';

import { createAlloApiConversation } from '@/lib/chat/alloApiConversations';
import type { ConversationCreator, NewConversationRequest } from '@/lib/chat/newConversation';
import { useConversationsStore } from '@/stores';
import { api } from '@/utils/api';

/**
 * Starting a conversation.
 *
 * The seam, and the whole of it: one function in, one conversation id out, and
 * the screen that calls it does not know how it was made. `app/(chat)/new.tsx`
 * has one "create" path and this is it.
 *
 * A hook rather than a plain function because the creator needs three things
 * that live in React: the viewer, the conversations already on this device, and
 * the store to put the new one in.
 */
export function useCreateConversation(): ConversationCreator {
  const { user } = useOxy();
  const viewerId = user?.id;
  const known = useConversationsStore((state) => state.conversations);
  const remember = useConversationsStore((state) => state.addConversation);

  return useCallback(
    (request: NewConversationRequest) =>
      createAlloApiConversation(request, {
        // Wrapped rather than passed by reference: `api.post` is a method, and
        // a method handed over as a value is one refactor away from needing the
        // receiver it no longer has.
        post: (endpoint, body) => api.post(endpoint, body),
        known,
        viewerId,
        remember,
      }),
    [known, viewerId, remember],
  );
}
