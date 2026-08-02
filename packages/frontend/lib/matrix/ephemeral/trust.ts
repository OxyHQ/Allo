import type { AlloIdentityTrust, AlloRoomTrust } from '@/lib/matrix/types';

/**
 * Whether an ephemeral conversation may be written into.
 *
 * The decision, on its own, as a pure function of {@link AlloRoomTrust} — so
 * that the rule can be read in one place and tested without a homeserver, and so
 * that both halves of the port apply the same one. What calls it is
 * `guard.ts`.
 *
 * ## What this enforces, exactly
 *
 * A send is refused when this device's own identity is not cross-signing
 * verified, or when anybody in the room has an identity this device cannot
 * account for. **The refusal is the enforcement.** Nothing leaves the device, so
 * the Megolm session for that message is never created and never shared —
 * sharing happens at encrypt time in both SDKs, and there is no encrypt.
 *
 * ## What it does not enforce, and why not
 *
 * Matrix does have a crypto-level version of this: `CollectStrategy` in the Rust
 * SDK, which the native binding exposes as
 * `ClientBuilder.roomKeyRecipientStrategy` and `matrix-js-sdk` as
 * `CryptoApi.setDeviceIsolationMode`. Both are **per client**, decided once when
 * the client is built, and a client has one crypto store — so switching it on
 * would switch it on for ordinary conversations too. That is not a tuning
 * choice, it is the failure `docs/matrix/data-model.md` §5.2(a) named: with
 * `OnlyTrustedDevices`, a message to somebody who installed Allo this morning
 * reaches none of their devices, because nobody has verified them; with
 * `IdentityBasedStrategy`, it reaches none of their devices until they have
 * published a cross-signing identity. Ordinary chats would break to protect a
 * tier the user did not choose for them.
 *
 * `matrix-js-sdk` alone has a per-room override — `Room.setBlacklistUnverifiedDevices`,
 * which reaches `CollectStrategy::deviceBasedStrategy(only_allow_trusted_devices)`.
 * It is not used, for two reasons: the native binding has no counterpart, so
 * using it would make the two platforms behave differently in a way the port
 * cannot express; and it means *verified*, which — see below — nobody is.
 *
 * So the trust check lives here, above both SDKs, and the room key still goes to
 * every device of every participant whenever a send *is* allowed. That is
 * gap 2 in `docs/matrix/ephemeral.md`.
 *
 * ## `pinned` counts, and that is a decision worth stating
 *
 * Allo has no interactive verification flow — no emoji comparison, no QR — so no
 * participant is ever {@link AlloIdentityTrust} `verified`. A rule that demanded
 * it would refuse every message in every ephemeral conversation for ever, which
 * is not a stricter feature, it is an absent one. What is demanded instead is
 * that the identity be **known here and unchanged since**: trust on first use.
 * It stops a homeserver that swaps somebody's identity after the fact; it does
 * not stop one that lied the first time. The interface says that in those words.
 */

/** Why an ephemeral conversation will not accept a message right now. */
export type AlloEphemeralRefusal =
  /**
   * This device has not taken the cross-signing keys out of 4S, so nothing it
   * sends can be attributed to the account by anybody else.
   */
  | { readonly kind: 'own-device-unverified' }
  /** Somebody in the room has an identity this device cannot account for. */
  | {
      readonly kind: 'members-untrusted';
      /** Their Matrix user ids, in the order the room lists them. Never empty. */
      readonly userIds: readonly string[];
    };

/**
 * Which states of somebody's identity are good enough to send alongside.
 *
 * A table rather than a condition, so that a value added to
 * {@link AlloIdentityTrust} is a type error here rather than a state that
 * silently falls on the permissive side.
 */
const ACCEPTABLE: Readonly<Record<AlloIdentityTrust, boolean>> = {
  verified: true,
  pinned: true,
  changed: false,
  unknown: false,
};

/**
 * The reason to refuse, or `undefined` when the conversation may be written
 * into.
 *
 * The own-device check comes first because it is the one the user can act on
 * alone, and reporting "three people are not trusted" to somebody whose own
 * device is the problem sends them after the wrong thing.
 */
export function ephemeralSendRefusal(trust: AlloRoomTrust): AlloEphemeralRefusal | undefined {
  if (trust.ownDevice !== 'verified') {
    return { kind: 'own-device-unverified' };
  }
  const untrusted = trust.members
    .filter((member) => !ACCEPTABLE[member.trust])
    .map((member) => member.userId);
  return untrusted.length === 0 ? undefined : { kind: 'members-untrusted', userIds: untrusted };
}
