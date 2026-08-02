import type { AlloIdentityTrust, AlloRoomTrust } from '@/lib/matrix/types';

/**
 * Reading cryptographic identity in a browser.
 *
 * Importing nothing of `matrix-js-sdk` at runtime, like every module under
 * `web/`: the package is ESM and Jest cannot load it, so taking what is needed
 * of it as a shape is the only way any of this can be tested. See
 * `docs/matrix/ui-wiring.md` §8.3.
 */

/** What this module needs of `matrix-js-sdk`'s `UserVerificationStatus`. */
export interface WebVerificationStatus {
  /**
   * Whether this device has ever had an identity for them.
   *
   * The SDK's own note: when this is `false` every other flag is `false` too,
   * so it has to be asked first or "never seen" reads as "seen and not
   * verified".
   */
  readonly known: boolean;
  /**
   * Their identity changed since it was first seen, and the new one has not been
   * verified.
   *
   * Covers both a pin violation and a verification violation, which is *more*
   * than the native binding can report — see `native/trust.ts`.
   */
  readonly needsUserApproval: boolean;
  isVerified(): boolean;
}

/**
 * How far somebody's identity is trusted here.
 *
 * Same order of questions as the native half, and for the same reason: an
 * identity that replaced another one has to be reported as `changed` even when
 * the SDK would call the new one verified.
 */
export function toIdentityTrust(status: WebVerificationStatus): AlloIdentityTrust {
  if (!status.known) {
    return 'unknown';
  }
  if (status.needsUserApproval) {
    return 'changed';
  }
  return status.isVerified() ? 'verified' : 'pinned';
}

/**
 * Whether this device can be attributed to the account by anybody else.
 *
 * Read from the viewer's *own* verification status rather than from
 * `getDeviceVerificationStatus`, because that is the question the native half
 * answers: both end up at `OwnUserIdentity::is_verified()` inside the same Rust
 * crypto machine, one compiled to WebAssembly and one to a native library.
 * Asking about the device instead would answer a narrower question and the two
 * platforms would disagree about a room whose members had not changed.
 */
export function toOwnDeviceTrust(status: WebVerificationStatus): AlloRoomTrust['ownDevice'] {
  if (!status.known) {
    // The crypto stack has no identity for this account yet, which is what it
    // looks like before recovery has run. Not "unverified": that is a state the
    // user has to act on, and this one resolves itself.
    return 'unknown';
  }
  return status.isVerified() ? 'verified' : 'unverified';
}
