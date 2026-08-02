import { MembershipState_Tags, StateEventType } from '@unomed/react-native-matrix-sdk';
import type { MembershipState, RoomMember } from '@unomed/react-native-matrix-sdk';

import { orderRoomMembers } from '@/lib/matrix/roomMembers';
import type { AlloRoomDetails, AlloRoomMember, AlloRoomRights } from '@/lib/matrix/types';

/**
 * Reading who is in a room, on iOS and Android.
 *
 * Its own module, and structurally typed like `roomSummaries.ts`, because the
 * two things it does are the two things a test needs to be able to drive: the
 * binding hands the member list over as a *paged iterator* rather than an array,
 * and it reports permissions through an object whose methods answer for the
 * current user only.
 */

/**
 * How many members are taken from the iterator at a time.
 *
 * The iterator is the binding's only way to read the list and each pull crosses
 * the FFI boundary, so this is a trade between round trips and the size of one
 * copy. A family group fits in a single pull; a room of a thousand takes ten.
 */
const MEMBER_CHUNK_SIZE = 100;

/**
 * The fields of `RoomMember` a member row reads.
 *
 * A `Pick` for the same reason `RoomSummaryFields` is one: the binding stays
 * the authority on what each field is, and a fixture in a test does not have to
 * invent a power level and a suggested role to say that somebody is in a room.
 */
export type MemberFields = Pick<RoomMember, 'userId' | 'displayName' | 'membership'>;

/** What this module needs of the binding's member iterator. */
export interface MemberPages {
  nextChunk(chunkSize: number): MemberFields[] | undefined;
}

/** What this module needs of the binding's power levels. */
export interface RoomAuthority {
  canOwnUserInvite(): boolean;
  canOwnUserSendState(stateEvent: StateEventType): boolean;
}

/** What this module needs of a room handle. See `roomSummaries.ts`. */
export interface RoomDetailsEntry {
  id(): string;
  displayName(): string | undefined;
  isDirect(): Promise<boolean>;
  members(): Promise<MemberPages>;
  getPowerLevels(): Promise<RoomAuthority>;
}

/**
 * The memberships that put somebody in the room.
 *
 * Everything else — left, banned, knocking, and the custom states the protocol
 * allows — is not "who is in this conversation", and a list that included them
 * would answer a different question from the one the screen is asking.
 */
const MEMBER_STATES: Partial<Record<MembershipState['tag'], AlloRoomMember['membership']>> = {
  [MembershipState_Tags.Join]: 'joined',
  [MembershipState_Tags.Invite]: 'invited',
};

export async function readRoomDetails(room: RoomDetailsEntry): Promise<AlloRoomDetails> {
  // Independent reads, and each one a round trip: awaiting them in sequence
  // would double the wait before the screen can draw anything.
  const [isDirect, pages, authority] = await Promise.all([
    room.isDirect(),
    room.members(),
    room.getPowerLevels(),
  ]);

  return {
    roomId: room.id(),
    // The binding computes this from `m.room.name` and falls back to the
    // members, which is the answer the port wants: a group nobody named still
    // has something to draw.
    name: room.displayName(),
    isDirect,
    members: orderRoomMembers(collectMembers(pages)),
    rights: toRights(authority),
  };
}

export function toRights(authority: RoomAuthority): AlloRoomRights {
  return {
    canInvite: authority.canOwnUserInvite(),
    // The permission to rename a room *is* the permission to send its
    // `m.room.name` state event; Matrix has no separate one, and asking for
    // anything else would be answering a different question.
    canRename: authority.canOwnUserSendState(StateEventType.RoomName),
  };
}

/**
 * Drains the iterator into the members Allo draws.
 *
 * `nextChunk` answers `undefined` when there is nothing left, which is the only
 * end-of-list signal the binding gives. **An empty array is not that signal**,
 * and a loop that stopped on one would report a room as empty because of a page
 * that happened to hold nobody — the members after it are never asked for.
 */
function collectMembers(pages: MemberPages): AlloRoomMember[] {
  const members: AlloRoomMember[] = [];
  for (;;) {
    const chunk = pages.nextChunk(MEMBER_CHUNK_SIZE);
    if (chunk === undefined) {
      return members;
    }
    for (const member of chunk) {
      const membership = MEMBER_STATES[member.membership.tag];
      if (membership !== undefined) {
        members.push({
          userId: member.userId,
          // The binding reports an empty display name as an empty string for a
          // member who has set none, and an empty name is not a name: it would
          // draw a row with nothing in it and sort before everybody.
          displayName:
            member.displayName === undefined || member.displayName === ''
              ? undefined
              : member.displayName,
          membership,
        });
      }
    }
  }
}
