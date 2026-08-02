import { VerificationState } from '@unomed/react-native-matrix-sdk';

import type { AlloIdentityTrust, AlloRoomTrust } from '@/lib/matrix/types';

/**
 * Reading cryptographic identity on iOS and Android.
 *
 * Structurally typed like `roomSummaries.ts` and `roomDetails.ts`: the binding
 * hands identities over as FFI objects with methods, and a test needs to be able
 * to say "somebody whose identity is known and unverified" without one.
 */

/** What this module needs of the binding's `UserIdentity`. */
export interface NativeUserIdentity {
  isVerified(): boolean;
  /** Was verified before and is not the same identity now. */
  hasVerificationViolation(): boolean;
}

/**
 * How far somebody's identity is trusted here.
 *
 * The order of the branches is the order of severity, and `changed` has to come
 * before `verified`: the binding's `is_verified()` answers about the identity
 * that is published *now*, and an identity in violation is precisely one that
 * replaced a verified one. Asking the questions the other way round would report
 * the substitution as fine.
 *
 * **A pin violation is not reported, because the binding cannot report one.**
 * `UserIdentityLike` offers `hasVerificationViolation`, `wasPreviouslyVerified`
 * and `isVerified` and nothing about pinning; the `IdentityState.PinViolation`
 * value exists in the crypto crate's vocabulary but only reaches this binding
 * through `Room.subscribeToIdentityStatusChanges`, which is a stream of changes
 * and not an answer to a question. So an identity that changed without ever
 * having been verified reads as `pinned` here and as `changed` in a browser.
 * That asymmetry is gap 5 in `docs/matrix/ephemeral.md`; it is written down
 * rather than papered over, because the paper would be a snapshot assembled from
 * a subscription.
 */
export function toIdentityTrust(identity: NativeUserIdentity | undefined): AlloIdentityTrust {
  if (identity === undefined) {
    return 'unknown';
  }
  if (identity.hasVerificationViolation()) {
    return 'changed';
  }
  return identity.isVerified() ? 'verified' : 'pinned';
}

/**
 * Whether this device can be attributed to the account by anybody else.
 *
 * `verificationState()` is the binding's view of *our own* identity — the Rust
 * SDK computes it from `OwnUserIdentity::is_verified()` — which is the same
 * question the web half asks of `getUserVerificationStatus` for the viewer's own
 * user id. `Unknown` is a real answer and not a failure: the crypto stack starts
 * in the background and has not always settled, and treating that as unverified
 * would refuse a send for a reason that stops being true a second later.
 */
const OWN_DEVICE: Readonly<Record<VerificationState, AlloRoomTrust['ownDevice']>> = {
  [VerificationState.Unknown]: 'unknown',
  [VerificationState.Verified]: 'verified',
  [VerificationState.Unverified]: 'unverified',
};

export function toOwnDeviceTrust(state: VerificationState): AlloRoomTrust['ownDevice'] {
  return OWN_DEVICE[state];
}
