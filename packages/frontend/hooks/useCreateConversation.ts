import { useCallback } from 'react';
import { useConversationActions } from '@allo/react';

import { planConversation, type ConversationCreator, type NewConversationRequest } from '@/lib/chat/newConversation';

/**
 * Starting a conversation.
 *
 * The seam, and the whole of it: one function in, one conversation id out, and
 * the screen that calls it does not know how it was made. `app/(chat)/new.tsx`
 * and the profile screen's "message" button have one "create" path and this
 * is it.
 *
 * `planConversation` decides what is a direct message and what is a group;
 * the SDK makes it. A direct message between the same two people is
 * idempotent on the server, so opening one twice answers the same id. A group
 * is named after it exists, because the SDK's create takes members and the
 * name travels as an encrypted message of its own.
 *
 * Somebody who has not installed Allo is a valid participant. The SDK creates
 * the conversation with whatever devices exist (possibly only this one), lists
 * the person in `unreachableMemberAccountIds`, holds what is sent, and adds
 * their first device when it appears — so there is no "not found" here to
 * catch, and the screens do not look for one. Whatever does throw is a real
 * failure and is shown as such.
 */
export function useCreateConversation(): ConversationCreator {
  const { createDirect, createGroup, rename } = useConversationActions();

  return useCallback(
    async (request: NewConversationRequest) => {
      const plan = planConversation(request);
      if (plan.isDirect) {
        const conversation = await createDirect(plan.participantIds[0]);
        return conversation.id;
      }
      const conversation = await createGroup([...plan.participantIds]);
      if (plan.name !== undefined) await rename(conversation.id, plan.name);
      return conversation.id;
    },
    [createDirect, createGroup, rename],
  );
}
