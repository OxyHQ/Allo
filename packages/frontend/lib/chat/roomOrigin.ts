import type { AlloEncryptionState, AlloRoomSummary } from '@/lib/matrix/types';

/**
 * Where a conversation came from, and what may therefore be claimed about it
 * (`docs/matrix/data-model.md` §5.3).
 *
 * ## The rule, and why it is one function
 *
 * §5.3 states it in one line, and says it is stated explicitly *because this is
 * where the mistakes get made*: **the padlock is decided by the encryption state;
 * the network mark is decided by the bridge. Mixing them is how you end up
 * showing a padlock on a room the bridge reads whole.**
 *
 * So both signals are computed here, together, once, and the components draw what
 * they are handed. A screen that decided for itself would be one `||` away from
 * the failure the whole feature exists to prevent.
 *
 * ## Where the design contradicts itself, and which side this takes
 *
 * §5.3 nominates `latestEncryptionState() == NotEncrypted` as the PRIMARY mark of
 * a bridged room — a cryptographic property nobody can fake by setting a field,
 * unlike an appservice-provided flag. That reasoning is right, and the conclusion
 * it is used for is not, because §2.3 of `bridges.md` sets the Phase 1 rule the
 * other way: **`encryption.msc4190: true` on every bridge**, which is
 * end-to-bridge encryption. Under it the Matrix room IS encrypted. The bridge
 * holds the keys and decrypts every message in order to re-encrypt it onto
 * WhatsApp or Telegram — that is what a bridge is.
 *
 * A room can therefore be `encrypted` and read in full by a third party. Under
 * §5.3's primary mark alone, that room gets a padlock. It must not: the padlock
 * is a claim about who can read the conversation, and here the answer includes a
 * process in our own cluster and a foreign network's servers.
 *
 * Hence {@link conversationSecurity} requires **both** an encrypted room and an
 * origin known not to be bridged before it will say `end-to-end`. The extra
 * condition is not belt-and-braces for a case that cannot happen; it is the case
 * the deployment plan creates on purpose.
 *
 * ## The hole that is left, stated rather than hidden
 *
 * Bridged-ness is recognised from the appservice's ghost-user MXID namespace —
 * §5.3's own secondary mark. It is a convention: `username_template` is a bridge
 * registration setting, and an operator who changes it makes these rooms
 * unrecognisable here.
 *
 * With end-to-bridge encryption on, an unrecognised bridged room would be drawn
 * as end-to-end. **That is a real hole and it is not closed by this file.**
 * Closing it needs the room's `m.bridge` state event (MSC2346, still unstable,
 * prefixed `uk.half-shot.bridge`), which the port does not expose today — see
 * `docs/matrix/linked-accounts.md` §6. Until then the hole is bounded by the fact
 * that no bridge is enabled in any deployment, so no bridged room exists to
 * mislabel.
 */

/** What the UI may claim about who can read a conversation. */
export type ConversationSecurity =
  /**
   * Encrypted, and no third party is party to it. The only value that earns a
   * padlock.
   */
  | { readonly kind: 'end-to-end' }
  /**
   * Carried by a bridge. Never a padlock, whatever the room's encryption state
   * says: the bridge holds the remote network's keys by definition.
   */
  | { readonly kind: 'bridged'; readonly networkId: string }
  /**
   * Nothing to claim — an unencrypted room, or one whose encryption state has
   * not arrived yet.
   *
   * Silence rather than an open padlock. `unknown` genuinely means "this device
   * does not know", and drawing a broken padlock for it would report a fact
   * nobody established.
   */
  | { readonly kind: 'none' };

/**
 * An appservice's ghost-user namespace: everything before the remote id.
 *
 * `@telegram_` matches `@telegram_123456:allo.you`. The trailing separator is
 * part of the prefix on purpose — without it, a hypothetical `slackware` network
 * would claim `@slack_`'s users.
 */
export interface GhostNamespace {
  readonly networkId: string;
  readonly localpartPrefix: string;
}

/**
 * The namespaces to look for, derived from the networks the server enabled.
 *
 * Built from the server's list rather than from a constant, for the same reason
 * everything else in this feature is: the app carries no list of networks
 * (`bridges.md` §9.2), and a build that predated Slack must still mark Slack's
 * rooms once a deployment turns it on.
 *
 * `<id>_` is mautrix's default `username_template` shape. It is a convention and
 * not a guarantee, which is why this returns a value the caller passes in
 * explicitly instead of reaching for a module-level constant: the day the server
 * publishes its real namespaces, one call site changes.
 */
export function ghostNamespacesFor(
  networkIds: readonly string[],
): readonly GhostNamespace[] {
  return networkIds.map((networkId) => ({
    networkId,
    localpartPrefix: `${networkId}_`,
  }));
}

/**
 * The network a Matrix user id belongs to, or `undefined` for a real person.
 *
 * Compared on the localpart only. A server name is not evidence of anything here
 * — ghosts live on the same homeserver as everybody else — and matching against
 * the whole MXID would make the answer depend on which deployment is running.
 */
export function ghostNetworkFor(
  userId: string,
  namespaces: readonly GhostNamespace[],
): string | undefined {
  if (!userId.startsWith('@')) return undefined;
  const separator = userId.indexOf(':');
  const localpart = userId.slice(1, separator === -1 ? undefined : separator);

  return namespaces.find((namespace) => localpart.startsWith(namespace.localpartPrefix))
    ?.networkId;
}

/**
 * Decides both marks for one room.
 *
 * `participantIds` is every Matrix user id the caller knows about in that room.
 * A room is bridged if any of them is a ghost — one is enough, because a bridge
 * puts its ghost in every room it carries, and there is no arrangement where a
 * ghost is present and the conversation is not bridged.
 *
 * The caller passing an incomplete list can only produce `none` where `bridged`
 * was true, never the reverse. That asymmetry is the reason this takes ids rather
 * than reading them itself: it is honest about being fed partial information, and
 * partial information here degrades towards saying less.
 */
export function conversationSecurity(
  encryption: AlloEncryptionState,
  participantIds: readonly string[],
  namespaces: readonly GhostNamespace[],
): ConversationSecurity {
  for (const participantId of participantIds) {
    const networkId = ghostNetworkFor(participantId, namespaces);
    if (networkId !== undefined) {
      return { kind: 'bridged', networkId };
    }
  }

  /**
   * Both conditions. See the header: an end-to-bridge-encrypted room satisfies
   * the first one and must still never be called end-to-end.
   */
  if (encryption === 'encrypted') {
    return { kind: 'end-to-end' };
  }

  return { kind: 'none' };
}

/**
 * The one predicate every padlock in the app must go through.
 *
 * Exported as its own function so that "does this get a padlock?" has exactly one
 * answer in the codebase, and so that a component cannot arrive at one by
 * inspecting `kind` and getting the case analysis subtly wrong.
 */
export function showsEncryptionPadlock(security: ConversationSecurity): boolean {
  return security.kind === 'end-to-end';
}

/**
 * The same decision for a room summary straight off the room list.
 *
 * The summary carries exactly one Matrix user id — the sender of its latest
 * message — so that is what is checked. It is genuinely partial: a bridged
 * conversation whose most recent message is the user's own has no ghost in
 * `participantIds` and comes back `none` until the other side replies.
 *
 * Accepted rather than papered over, because the alternative is a per-room member
 * fetch on every row of a list that scrolls. The consequence is a mark that
 * sometimes appears late, and — see the header — a padlock hole that is bounded
 * by no bridge being enabled anywhere.
 */
export function roomSummarySecurity(
  summary: Pick<AlloRoomSummary, 'encryption' | 'latestMessage'>,
  namespaces: readonly GhostNamespace[],
): ConversationSecurity {
  const sender = summary.latestMessage?.sender;
  return conversationSecurity(
    summary.encryption,
    sender === undefined ? [] : [sender],
    namespaces,
  );
}
