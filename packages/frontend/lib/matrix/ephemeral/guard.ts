import { MatrixEphemeralUntrustedError } from '@/lib/matrix/errors';
import type { AlloEphemeralPolicy, AlloRoomTrust } from '@/lib/matrix/types';

import { ephemeralSendRefusal } from './trust';

/**
 * The check every send in an ephemeral conversation goes through, in one object
 * both halves of the port own an instance of.
 *
 * It lives inside `lib/matrix/` rather than in `lib/chat/` on purpose. A gate in
 * the app's seam would be a gate the port can be used around: the next screen to
 * reach for `AlloTimelineHandle.sendText` directly — and there is nothing
 * stopping it — would be sending into an ephemeral conversation with no check at
 * all, and nothing about the result would look different. Here it is between the
 * caller and the SDK, and `__tests__/matrix/ephemeralSendGate.test.ts` is what
 * keeps every send path passing through it.
 *
 * Both dependencies are functions rather than a client, so this can be driven
 * from a test without either SDK — the same shape `MatrixRuntimeDependencies`
 * and `OidcLoginClient` use.
 */
export interface EphemeralGuardDependencies {
  /**
   * The account's ephemeral conversations.
   *
   * Called on every guarded send. That is affordable because both SDKs answer it
   * from the local account data store that sync fills — no request — and it is
   * *necessary* rather than merely acceptable: a cached answer would let a
   * conversation the user made ephemeral on another device keep behaving as an
   * ordinary one until the app was restarted, and the failure would be silent.
   */
  readonly policies: () => Promise<ReadonlyMap<string, AlloEphemeralPolicy>>;
  readonly trust: (roomId: string) => Promise<AlloRoomTrust>;
}

export class EphemeralSendGuard {
  readonly #dependencies: EphemeralGuardDependencies;

  constructor(dependencies: EphemeralGuardDependencies) {
    this.#dependencies = dependencies;
  }

  /**
   * Lets the send happen, or throws {@link MatrixEphemeralUntrustedError}.
   *
   * An ordinary conversation costs one local map lookup and no crypto work at
   * all: the trust of the room's members is only read once the room is known to
   * be ephemeral, which is what keeps this off the critical path of every
   * message the app sends.
   */
  async requireSendable(roomId: string): Promise<void> {
    const policies = await this.#dependencies.policies();
    if (!policies.has(roomId)) {
      return;
    }
    const refusal = ephemeralSendRefusal(await this.#dependencies.trust(roomId));
    if (refusal !== undefined) {
      throw new MatrixEphemeralUntrustedError(roomId, refusal);
    }
  }
}
