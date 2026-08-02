import { orderRoomMembers } from '@/lib/matrix/roomMembers';
import type { AlloRoomDetails, AlloRoomMember, AlloRoomRights } from '@/lib/matrix/types';

/**
 * Reading who is in a room, in a browser.
 *
 * Structurally typed and importing nothing of `matrix-js-sdk` at runtime, like
 * every module under `web/`: the package is ESM and Jest cannot load it, so the
 * only way this logic can be tested at all is if it takes what it needs of the
 * SDK as a shape. See `docs/matrix/ui-wiring.md` §8.3.
 */

/** The state event that names a room. Not imported: see the note above. */
const ROOM_NAME_EVENT_TYPE = 'm.room.name';

/** What this module needs of `matrix-js-sdk`'s `RoomMember`. */
export interface WebRoomMember {
  readonly userId: string;
  /** The display name, which the SDK falls back to the user id for. */
  readonly rawDisplayName?: string;
  readonly membership?: string;
}

/** What this module needs of `matrix-js-sdk`'s `RoomState`. */
export interface WebRoomState {
  maySendStateEvent(stateEventType: string, userId: string): boolean;
}

/** What this module needs of `matrix-js-sdk`'s `Room`. */
export interface WebRoomDetailsSource {
  readonly roomId: string;
  readonly name: string;
  getMembers(): WebRoomMember[];
  canInvite(userId: string): boolean;
}

/**
 * The membership strings that put somebody in the room.
 *
 * The spec's own values, and not the SDK's `KnownMembership` enum, for the same
 * reason nothing here imports the SDK. Everything else — `leave`, `ban`,
 * `knock`, and a membership the SDK has not heard of — is not "who is in this
 * conversation".
 */
const MEMBER_STATES: Readonly<Record<string, AlloRoomMember['membership']>> = {
  join: 'joined',
  invite: 'invited',
};

export function readRoomDetails(
  room: WebRoomDetailsSource,
  state: WebRoomState,
  viewerId: string,
  isDirect: boolean,
): AlloRoomDetails {
  return {
    roomId: room.roomId,
    // The SDK computes this from `m.room.name` and falls back to the members;
    // an empty one is not a name. The same rule the room list follows.
    name: room.name === '' ? undefined : room.name,
    isDirect,
    members: orderRoomMembers(toMembers(room.getMembers())),
    rights: toRights(room, state, viewerId),
  };
}

/**
 * Just who is in the room, without the permissions a details screen also needs.
 *
 * The counterpart of the native half's function of the same name, and there for
 * the same reason: `roomTrust` runs before every send into an ephemeral
 * conversation and has no use for power levels.
 */
export function readRoomMembers(
  room: Pick<WebRoomDetailsSource, 'getMembers'>,
): readonly AlloRoomMember[] {
  return orderRoomMembers(toMembers(room.getMembers()));
}

export function toRights(
  room: WebRoomDetailsSource,
  state: WebRoomState,
  viewerId: string,
): AlloRoomRights {
  return {
    canInvite: room.canInvite(viewerId),
    // The permission to rename a room *is* the permission to send its
    // `m.room.name` state event; Matrix has no separate one.
    canRename: state.maySendStateEvent(ROOM_NAME_EVENT_TYPE, viewerId),
  };
}

function toMembers(members: readonly WebRoomMember[]): AlloRoomMember[] {
  const kept: AlloRoomMember[] = [];
  for (const member of members) {
    const membership = member.membership === undefined ? undefined : MEMBER_STATES[member.membership];
    if (membership === undefined) {
      continue;
    }
    kept.push({
      userId: member.userId,
      // `rawDisplayName` and not `name`: the SDK's `name` falls back to the user
      // id and disambiguates duplicates by appending it, so a member with no
      // display name would arrive here looking as if they had one — and would
      // then be drawn as a name where the port promised none.
      displayName:
        member.rawDisplayName === undefined || member.rawDisplayName === ''
          ? undefined
          : member.rawDisplayName,
      membership,
    });
  }
  return kept;
}
