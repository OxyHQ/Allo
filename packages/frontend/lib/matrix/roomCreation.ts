import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * What every room Allo creates is, before either SDK's vocabulary.
 *
 * This lives above the platform split, beside `directMessage.ts`, and for the
 * same reason: these are statements about {@link AlloChatClient.createRoom}'s
 * contract rather than about either SDK. The two halves build completely
 * different objects out of them — a uniffi record on iOS and Android, a JSON
 * request body on the web — but they must agree on *what* they are building, or
 * the same tap makes a different room on each platform.
 *
 * **The one thing that is not derived from anything here is encryption.** There
 * is no `encryptedFor(request)` below, because there is no request that answers
 * "no": each half writes encryption on unconditionally, from a literal, in the
 * one function that builds its parameters. Encryption in Matrix is one-way — a
 * room created without it can never be given it — so a room created in the clear
 * by mistake is a conversation that is permanently in the clear, and Allo is an
 * encrypted messenger. See {@link AlloCreateRoomRequest} for why the request type
 * carries no option for it either, and
 * `__tests__/matrix/encryptedRooms.test.ts` for the test that keeps both true.
 */

/**
 * How much power the people in a new room have.
 *
 * Named in Allo's words rather than either SDK's so that both halves map from
 * the same decision. The difference is only about power levels: both presets are
 * invite-only and neither is listed in the public directory.
 */
export type AlloRoomPreset =
  /**
   * Everyone invited gets the creator's power level.
   *
   * For a direct message, where there is no moderator: a conversation between
   * two people in which one of them can remove the other, rename the room and
   * the other cannot is not a conversation between two people.
   */
  | 'trusted-private-chat'
  /** The creator can name the room and invite; a group has an owner. */
  | 'private-chat';

export function roomPresetFor(request: AlloCreateRoomRequest): AlloRoomPreset {
  return request.isDirect ? 'trusted-private-chat' : 'private-chat';
}

/**
 * The name to give the room, which a direct message never has.
 *
 * `m.room.name` is a state event and state events are not encrypted
 * (`docs/matrix/data-model.md` §4), so a name is a string the homeserver can
 * read. A group has to have one anyway — that is what the members called it —
 * but a direct message does not need one: every client computes the name of a
 * one-to-one room from its members, and writing one would put two people's
 * names in the clear for nothing.
 *
 * A name made only of spaces is no name. It would be a room whose title is
 * blank in every client, which reads as a bug rather than as a choice.
 */
export function roomNameFor(request: AlloCreateRoomRequest): string | undefined {
  if (request.isDirect || request.name === undefined) {
    return undefined;
  }
  const name = request.name.trim();
  return name === '' ? undefined : name;
}

/**
 * The state event that makes a room encrypted, and the only algorithm Matrix has
 * for rooms.
 *
 * Written by the web half, which has to put the event in `initial_state`
 * itself; the native binding takes a boolean and writes the same event inside
 * Rust. The state key is empty because `m.room.encryption` is a property of the
 * room and there is only ever one of it.
 */
export const ROOM_ENCRYPTION_EVENT_TYPE = 'm.room.encryption';
export const ROOM_ENCRYPTION_STATE_KEY = '';
export const MEGOLM_ALGORITHM = 'm.megolm.v1.aes-sha2';
