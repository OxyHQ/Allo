import { useMemo, useSyncExternalStore } from 'react';

import type { Conversation } from '@/app/(chat)/index';
import { useEphemeralPolicies } from '@/hooks/useEphemeralPolicy';
import { useMatrixEventLabels } from '@/hooks/useMatrixEventLabels';
import { CHAT_BACKEND } from '@/lib/chat/backend';
import { toConversation } from '@/lib/chat/matrixViewModel';
import { roomListSource } from '@/lib/chat/roomListSource';
import type { AlloRoomSummary, AlloUnsubscribe } from '@/lib/matrix/types';

/**
 * The conversation list, from the Matrix port.
 *
 * Answers `undefined` — not an empty list — when this build talks to the Express
 * API, so that the screen can fall through to the store it has always used with
 * `?? conversations` and the old path stays exactly one expression.
 *
 * There is no fetch here and no Effect: the port's sync loop is what populates
 * the list, and this hook only reads the list it publishes.
 */

const NO_ROOMS: readonly AlloRoomSummary[] = [];
const NO_UNSUBSCRIBE: AlloUnsubscribe = () => {};
const subscribeToNothing = (): AlloUnsubscribe => NO_UNSUBSCRIBE;
const noRooms = (): readonly AlloRoomSummary[] => NO_ROOMS;

const enabled = CHAT_BACKEND === 'matrix';

export function useMatrixConversations(): readonly Conversation[] | undefined {
  const rooms = useSyncExternalStore(
    enabled ? roomListSource.subscribe : subscribeToNothing,
    enabled ? roomListSource.getSnapshot : noRooms,
    noRooms,
  );

  // The same words the timeline uses for the same facts. A conversation whose
  // last message cannot be read on this device says so in the list too, and one
  // whose last message is a photograph says "Photo": an empty preview reads as a
  // conversation nobody has written in.
  const labels = useMatrixEventLabels();
  // A row of an ephemeral conversation says so, because the difference is not
  // visible from anything else in it: the messages look the same until they are
  // gone. See `docs/matrix/ephemeral.md` §4.
  const policies = useEphemeralPolicies();

  // Derived during render, as a mapping of the snapshot should be. An Effect that
  // mirrored this into state would render one frame of the previous list every
  // time a message arrived.
  return useMemo(
    () =>
      enabled
        ? rooms.map((room) => toConversation(room, labels, policies.has(room.roomId)))
        : undefined,
    [rooms, labels, policies],
  );
}
