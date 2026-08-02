import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * When creating a conversation means reusing one.
 *
 * This lives above the platform split, and is imported by both halves, because it
 * is a statement about {@link AlloChatClient.createRoom}'s contract rather than
 * about either SDK. The two implementations look up the existing room in
 * completely different ways — the binding keeps an index, `matrix-js-sdk` has
 * `m.direct` and nothing else — but they must agree on *when* to look, or the
 * same tap creates a second conversation on one platform and not the other.
 *
 * Two invitees are not a direct message however the caller labels it: `m.direct`
 * records one room per person, three people cannot share a conversation that
 * every client resolves to a pair, and there is no room to find. A request with
 * no invitees is a room the user is alone in, which is theirs and never anyone
 * else's.
 */
export function soleDirectInvitee(request: AlloCreateRoomRequest): string | undefined {
  if (!request.isDirect || request.invite.length !== 1) {
    return undefined;
  }
  return request.invite[0];
}
