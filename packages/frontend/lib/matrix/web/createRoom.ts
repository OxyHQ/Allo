import type { ICreateRoomOpts } from 'matrix-js-sdk';

import {
  MEGOLM_ALGORITHM,
  ROOM_ENCRYPTION_EVENT_TYPE,
  ROOM_ENCRYPTION_STATE_KEY,
  roomNameFor,
} from '@/lib/matrix/roomCreation';
import type { AlloCreateRoomRequest } from '@/lib/matrix/types';

/**
 * A request to start a conversation, as `matrix-js-sdk` wants it.
 *
 * The asymmetry with the native half is the same one attachments have. The Rust
 * binding takes `isEncrypted: true` and writes `m.room.encryption` itself; here
 * there is no such parameter, and a room is encrypted only because the client
 * that created it put the state event in `initial_state`. `createRoom` without
 * it succeeds, syncs, draws identically, and produces a conversation whose every
 * message the homeserver can read — and, because encryption in Matrix is
 * one-way, one that can never be repaired.
 *
 * So the event is built here, from constants, with nothing to switch on; this
 * module has no parameter, no option and no branch that could leave it out. What
 * proves it is `__tests__/matrix/web/createRoom.test.ts`, which reads the
 * options this returns rather than trusting that it was called.
 *
 * ## Why the two enums are not here
 *
 * `visibility` and `preset` are string enums of `matrix-js-sdk`, and a TypeScript
 * string enum admits no value but its own members — a plain `'private'` is not
 * assignable. Producing them would mean importing the SDK at runtime, and no
 * module under `web/` does: they take what they need of it as a structural type,
 * which is what lets them be tested at all (the package is ESM and Jest cannot
 * load it). So this returns everything except those two, and `client.web.ts`
 * supplies them from {@link AlloRoomPreset} through a table of its own.
 */
export type WebCreateRoomOptions = Omit<ICreateRoomOpts, 'visibility' | 'preset'>;

export function toCreateRoomOptions(request: AlloCreateRoomRequest): WebCreateRoomOptions {
  return {
    name: roomNameFor(request),
    is_direct: request.isDirect,
    // Copied rather than passed through: the request's array is the caller's,
    // and this object is about to be serialised into a request body.
    invite: [...request.invite],
    initial_state: [
      {
        type: ROOM_ENCRYPTION_EVENT_TYPE,
        state_key: ROOM_ENCRYPTION_STATE_KEY,
        content: { algorithm: MEGOLM_ALGORITHM },
      },
    ],
  };
}
