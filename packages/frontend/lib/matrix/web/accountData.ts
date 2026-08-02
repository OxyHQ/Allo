import type { EphemeralPolicyDocument } from '@/lib/matrix/ephemeral/policy';

/**
 * Allo's own account data, declared to `matrix-js-sdk`.
 *
 * `MatrixClient.getAccountData` and `setAccountData` are typed over the
 * `AccountDataEvents` interface, which the SDK leaves open precisely so that a
 * client can merge its own event types into it. Doing that is what keeps the two
 * calls in `client.web.ts` type-checked — including the *content*, which is
 * where a wrong shape would otherwise be written to the homeserver and read back
 * by every one of this user's devices.
 *
 * Two details worth knowing before touching this.
 *
 * The augmented module is `matrix-js-sdk/lib/@types/event` and not
 * `matrix-js-sdk`, because an interface merges only with the module that
 * declares it; the root merely re-exports, and augmenting the root would declare
 * a second, unrelated interface that nothing reads. It is the second internal
 * path this half depends on, after `lib/crypto-api/index.js`, and it is the same
 * trade: a path a future version may move, against giving up type checking.
 *
 * The key has to be written as a literal — a `declare module` block cannot use a
 * constant — so it is repeated from `EPHEMERAL_POLICIES_EVENT_TYPE`. Nothing has
 * to remember to keep the two in step: `client.web.ts` passes the constant to
 * these calls, so a literal that drifted would stop compiling there.
 */

declare module 'matrix-js-sdk/lib/@types/event' {
  interface AccountDataEvents {
    'so.oxy.allo.ephemeral_rooms': EphemeralPolicyDocument;
  }
}

/**
 * There is nothing to run here: the declaration above is the whole module.
 *
 * The empty export is what makes this file a module at all — a `declare module`
 * inside a script declares a new module instead of augmenting one — and
 * `client.web.ts` imports it for its side effect so that the dependency is
 * written down rather than left to the compiler happening to include the file.
 */
export {};
