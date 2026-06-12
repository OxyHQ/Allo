/**
 * Interop bridge (F3.x) — per-conversation capability resolution.
 *
 * Maps a conversation to the {@link NetworkCapabilities} of the network it rides
 * on. Native Allo conversations (no `network`, or `network === 'allo'`) resolve
 * to the all-supported `allo` matrix, so existing chats keep every feature and
 * behave EXACTLY as before. Bridged conversations (e.g. Telegram) resolve to that
 * network's conservative matrix, which the UI uses to hide/disable features the
 * target network can't carry (calls, polls, …).
 */

import { useMemo } from 'react';
import {
  NETWORK_CAPABILITIES,
  type Network,
  type NetworkCapabilities,
} from '@allo/shared-types';
import type { Conversation } from '@/app/(chat)/index';

/** The native network. A missing `network` is treated as native Allo. */
const NATIVE_NETWORK: Network = 'allo';

/** Resolve the network a conversation rides on, defaulting to native Allo. */
export function conversationNetwork(
  conversation: Pick<Conversation, 'network'> | null | undefined
): Network {
  return conversation?.network ?? NATIVE_NETWORK;
}

/** True when the conversation is NOT native Allo (i.e. bridged to an external network). */
export function isBridgedConversation(
  conversation: Pick<Conversation, 'network'> | null | undefined
): boolean {
  return conversationNetwork(conversation) !== NATIVE_NETWORK;
}

/**
 * Pure capability lookup (no hooks) for use in stores / non-React code. Native
 * conversations always return the `allo` (all-supported) matrix.
 */
export function getConversationCapabilities(
  conversation: Pick<Conversation, 'network'> | null | undefined
): NetworkCapabilities {
  return NETWORK_CAPABILITIES[conversationNetwork(conversation)];
}

/**
 * React hook returning the {@link NetworkCapabilities} for a conversation. The
 * result is memoized on the conversation's network so consumers don't re-render
 * unless the network actually changes.
 */
export function useConversationCapabilities(
  conversation: Pick<Conversation, 'network'> | null | undefined
): NetworkCapabilities {
  const network = conversationNetwork(conversation);
  return useMemo(() => NETWORK_CAPABILITIES[network], [network]);
}
