import { useSyncExternalStore } from 'react';

import { CHAT_BACKEND } from '@/lib/chat/backend';
import { ephemeralPolicies } from '@/lib/chat/ephemeralPolicies';
import type { AlloEphemeralPolicy, AlloUnsubscribe } from '@/lib/matrix/types';

/**
 * Which conversations disappear, and after how long.
 *
 * Answers an empty map on a build that talks to the Express API, so a screen can
 * read it unconditionally: the Express backend has no ephemeral conversations
 * and never will, because what makes one is a redaction on a homeserver.
 *
 * No Effect anywhere: `ephemeralPolicies` is an external store and subscribing
 * to it is what reads it.
 */

const NONE: ReadonlyMap<string, AlloEphemeralPolicy> = new Map();
const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;
const none = (): ReadonlyMap<string, AlloEphemeralPolicy> => NONE;

const enabled = CHAT_BACKEND === 'matrix';

export function useEphemeralPolicies(): ReadonlyMap<string, AlloEphemeralPolicy> {
  return useSyncExternalStore(
    enabled ? ephemeralPolicies.subscribe : subscribeToNothing,
    enabled ? ephemeralPolicies.getSnapshot : none,
    none,
  );
}

/** One conversation's policy, or `undefined` for an ordinary one. */
export function useEphemeralPolicy(
  conversationId: string | undefined,
): AlloEphemeralPolicy | undefined {
  const policies = useEphemeralPolicies();
  return conversationId === undefined ? undefined : policies.get(conversationId);
}
