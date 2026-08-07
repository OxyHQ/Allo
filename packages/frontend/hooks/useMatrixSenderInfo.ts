import { useCallback, useMemo } from 'react';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import {
  NO_CHAT_PERSON_REQUESTS,
  type ChatPeopleLookup,
  type ChatPersonRequest,
} from '@/lib/chat/people';
import type { Message } from '@/stores/messagesStore';

/**
 * WHO SENT EACH MESSAGE, on the Matrix backend.
 *
 * The counterpart of `useSenderInfo`, which is the Express one and cannot serve
 * both: it looks a sender up in the Oxy users store by the id it was handed, and
 * on Matrix that id is an MXID. The store has no entry under one, the
 * `senderId === user.id` comparison is an MXID against an Oxy id and is always
 * false, and a Matrix `Conversation` carries no `participants` to fall back to —
 * so it returned the empty string for every sender in every group. The names
 * over incoming bubbles were not wrong; there were none.
 *
 * Split in two — the ids to look up, then the drawing — because the conversation
 * needs the same people for a second thing: the ephemeral refusal names them,
 * and one lookup has to serve both. See `ConversationView`.
 */

/**
 * What a conversation needs to draw the people who spoke in it.
 *
 * Both backends answer this shape — see `useSenderInfo` for the other — so the
 * screen picks one and nothing downstream branches. Every one of them may answer
 * `undefined`, which means "draw nothing here": an identifier is never a fallback.
 */
export interface SenderInfo {
  readonly getSenderName: (senderId: string) => string | undefined;
  /** Without its `@`. */
  readonly getSenderHandle: (senderId: string) => string | undefined;
  readonly getSenderAvatar: (senderId: string) => string | undefined;
}

const enabled = CHAT_BACKEND === 'matrix';

/**
 * Everybody who spoke in what is on screen, once each.
 *
 * From the messages rather than from the room's member list, because that is who
 * has to be named: somebody who left is still the sender of what they said, and
 * a member who has never spoken needs no name here. `senderName` travels with
 * the id because for a bridged contact it is the only name there will ever be —
 * a mautrix bridge names its puppets — and for anybody on Allo's own homeserver
 * there is none at all.
 *
 * Empty on the Express backend, where senders are Oxy ids and `useSenderInfo`
 * already resolves them.
 */
export function useMessageSenderRequests(
  messages: readonly Message[],
): readonly ChatPersonRequest[] {
  return useMemo(() => {
    if (!enabled) {
      return NO_CHAT_PERSON_REQUESTS;
    }
    const seen = new Set<string>();
    const collected: ChatPersonRequest[] = [];
    for (const message of messages) {
      if (message.isSent || message.senderId === '' || seen.has(message.senderId)) {
        continue;
      }
      seen.add(message.senderId);
      collected.push({
        userId: message.senderId,
        matrixDisplayName: message.senderName,
      });
    }
    return collected;
  }, [messages]);
}

/**
 * Answers `undefined` when this build talks to the Express API, so
 * `ConversationView` can pick between the two providers with `??` and neither
 * hook needs to know about the other.
 */
export function useMatrixSenderInfo(people: ChatPeopleLookup): SenderInfo | undefined {
  const getSenderName = useCallback(
    (senderId: string): string | undefined => {
      // Empty while the lookup is in flight, and `undefined` is what the bubble
      // wants for "draw no name": an id has never been an acceptable answer, and
      // a name that appears and then changes is worse than one that appears a
      // moment late.
      const name = people(senderId)?.displayName;
      return name === undefined || name === '' ? undefined : name;
    },
    [people],
  );

  const getSenderHandle = useCallback(
    (senderId: string): string | undefined => people(senderId)?.handle,
    [people],
  );

  const getSenderAvatar = useCallback(
    (senderId: string): string | undefined => people(senderId)?.avatarUrl,
    [people],
  );

  return useMemo(
    () => (enabled ? { getSenderName, getSenderHandle, getSenderAvatar } : undefined),
    [getSenderName, getSenderHandle, getSenderAvatar],
  );
}
