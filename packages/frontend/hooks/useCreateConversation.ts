import { useCallback } from 'react';

import { useOxy } from '@oxyhq/services';

import { createAlloApiConversation } from '@/lib/chat/alloApiConversations';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { matrixConversationCreator } from '@/lib/chat/matrixConversations';
import type { ConversationCreator, NewConversationRequest } from '@/lib/chat/newConversation';
import { useConversationsStore } from '@/stores';
import { api } from '@/utils/api';

/**
 * Starting a conversation, on whichever backend this build talks to.
 *
 * The seam, and the whole of it: one function in, one conversation id out, and
 * the screen that calls it does not know which system answered. That is the
 * point — `app/(chat)/new.tsx` has one "create" path, not two, and the flag
 * decides underneath it.
 *
 * A hook rather than a plain function because the Express path needs three
 * things that live in React: the viewer, the conversations already on this
 * device, and the store to put the new one in. None of them exists on the Matrix
 * path — a room comes from sync and from nowhere else — so they are read
 * unconditionally and used in one branch. Reading them unconditionally is not
 * waste, it is the rule: {@link CHAT_BACKEND} is a build-time constant, so the
 * branch below is settled before the app runs and the hooks above it always run
 * in the same order.
 */
export function useCreateConversation(): ConversationCreator {
  const { user } = useOxy();
  const viewerId = user?.id;
  const known = useConversationsStore((state) => state.conversations);
  const remember = useConversationsStore((state) => state.addConversation);

  return useCallback(
    (request: NewConversationRequest) => {
      if (CHAT_BACKEND === 'matrix') {
        return matrixConversationCreator.create(request);
      }
      return createAlloApiConversation(request, {
        // Wrapped rather than passed by reference: `api.post` is a method, and
        // a method handed over as a value is one refactor away from needing the
        // receiver it no longer has.
        post: (endpoint, body) => api.post(endpoint, body),
        known,
        viewerId,
        remember,
      });
    },
    [known, viewerId, remember],
  );
}
