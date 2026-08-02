import { RoomPreset, RoomVisibility } from '@unomed/react-native-matrix-sdk';
import type { CreateRoomParameters } from '@unomed/react-native-matrix-sdk';

import {
  roomNameFor,
  roomPresetFor,
  type AlloRoomPreset,
} from '@/lib/matrix/roomCreation';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * A request to start a conversation, in the binding's vocabulary.
 *
 * Its own module rather than an object literal inside `client.native.ts` because
 * of the field in the middle of it: `isEncrypted`. That boolean is the whole of
 * Allo's promise about a new conversation, it is one keystroke away from being
 * the opposite, and a value that only exists inside an `await` cannot be
 * asserted on. Here it can — see `__tests__/matrix/nativeCreateRoom.test.ts`.
 */

const PRESETS: Readonly<Record<AlloRoomPreset, RoomPreset>> = {
  'trusted-private-chat': RoomPreset.TrustedPrivateChat,
  'private-chat': RoomPreset.PrivateChat,
};

export function toCreateRoomParameters(
  request: AlloCreateRoomRequest,
): CreateRoomParameters {
  return {
    name: roomNameFor(request),
    topic: undefined,
    // **Not derived from the request, and there is nothing in the request to
    // derive it from.** A room created without encryption can never be given
    // it, so this is the one parameter that has no caller and no condition. See
    // `lib/matrix/roomCreation.ts`.
    isEncrypted: true,
    isDirect: request.isDirect,
    // Private is about the room directory, and is not what keeps the room shut:
    // the preset's `join_rules: invite` is. A private room with public join
    // rules is one anybody who learns its id can walk into.
    visibility: new RoomVisibility.Private(),
    preset: PRESETS[roomPresetFor(request)],
    // Copied rather than passed through: the request's array is the caller's,
    // and this record crosses the FFI boundary.
    invite: [...request.invite],
    avatar: undefined,
    // Left to the preset. An override here would replace the whole power level
    // block, including the defaults that decide who can invite and who can
    // redact, with whatever this object happened to name.
    powerLevelContentOverride: undefined,
    joinRuleOverride: undefined,
    historyVisibilityOverride: undefined,
    canonicalAlias: undefined,
  };
}
