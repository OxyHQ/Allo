import type {
  AlloEphemeralPolicy,
  AlloTimelineItem,
} from '@/lib/matrix/types';

/**
 * When a message in an ephemeral conversation stops being shown, and when this
 * device removes it from the homeserver.
 *
 * Arithmetic and nothing else. Every function here is pure and takes `now` as an
 * argument, which is what makes a deadline something a test can stand on either
 * side of rather than something that happens eventually.
 *
 * ## The two halves, and why one is much weaker than the other
 *
 * **Redaction** is real. `AlloTimelineHandle.redact` asks the homeserver to
 * strip the event's content, and afterwards there is nothing for any key to
 * decrypt, on any device, for anyone in the room. It is the whole reason this
 * tier exists: the key backup cannot be kept away from a room, so the content is
 * taken away from the key instead.
 *
 * **Hiding** is a courtesy. {@link maskExpiredItems} stops this device drawing a
 * message once it is past its deadline, before anybody has redacted anything. It
 * protects against a sender who is offline; it protects against nothing else. A
 * modified Allo, a different Matrix client, a screenshot, or somebody reading
 * over a shoulder all defeat it, and the interface must not suggest otherwise.
 *
 * Only the sender can redact their own message — that is Matrix's rule, not
 * Allo's — so a conversation's messages disappear from the homeserver exactly to
 * the extent that each participant's own client is running and knows the
 * conversation is ephemeral. See `docs/matrix/ephemeral.md` §3 and §5.
 */

/** When a message sent at `sentAt` expires. Milliseconds since the epoch. */
export function ephemeralExpiryAt(sentAt: number, policy: AlloEphemeralPolicy): number {
  return sentAt + policy.lifetimeMs;
}

/**
 * Whether a message is past its deadline.
 *
 * Inclusive of the deadline itself: a message whose lifetime has exactly run out
 * has run out. A row whose timestamp is not a finite number — which no SDK
 * should produce and neither has a reason to — is treated as *not* expired,
 * because the alternative is hiding a message whose age nobody could establish.
 */
export function isEphemeralExpired(
  sentAt: number,
  policy: AlloEphemeralPolicy,
  now: number,
): boolean {
  return Number.isFinite(sentAt) && now >= ephemeralExpiryAt(sentAt, policy);
}

/**
 * What a row says once it is expired.
 *
 * Three of the port's content kinds are replaced and three are left alone, and
 * the split is about what a row would otherwise reveal:
 *
 * - `text`, `media` and `unsupported` carry, or point at, what somebody wrote.
 *   They become {@link AlloEventContent} `expired`.
 * - `redacted` is already gone from the homeserver, and saying "expired" about
 *   it would replace the stronger fact with the weaker one.
 * - `undecryptable` has never been readable here, and telling the reader it
 *   expired would hide that this device is missing a key — which is a problem
 *   they may need to act on, and which outlives the message.
 * - `expired` is already this.
 *
 * The array is returned unchanged when nothing expired, which is the common case
 * and is what keeps a timeline from re-rendering on every tick of the clock.
 */
export function maskExpiredItems(
  items: readonly AlloTimelineItem[],
  policy: AlloEphemeralPolicy,
  now: number,
): readonly AlloTimelineItem[] {
  let changed = false;
  const masked = items.map((item) => {
    if (!hidesContent(item) || !isEphemeralExpired(item.sentAt, policy, now)) {
      return item;
    }
    changed = true;
    return { ...item, content: { kind: 'expired' } as const };
  });
  return changed ? masked : items;
}

/**
 * The rows this device should redact, by the key the timeline addresses them
 * with.
 *
 * Three conditions, and each of them is load-bearing:
 *
 * - **the viewer's own.** Matrix lets the sender redact their own event; asking
 *   to redact somebody else's is a request the homeserver refuses unless the
 *   viewer has the power level for it, and a client that tried would generate a
 *   failed request per expired message per sweep, for ever.
 * - **accepted by the homeserver.** A row still on its way out has no event id,
 *   and there is nothing to redact until it has one. It will be caught by the
 *   next sweep.
 * - **not already gone.** A redacted row stays in the timeline as a skeleton,
 *   and redacting it again is a request that does nothing.
 *
 * Must be given the timeline as the port reported it, **before**
 * {@link maskExpiredItems}: masking turns exactly the rows that need redacting
 * into `expired` ones, and this would then find none of them.
 */
export function ephemeralRedactionsDue(
  items: readonly AlloTimelineItem[],
  policy: AlloEphemeralPolicy,
  now: number,
): readonly string[] {
  return items
    .filter(
      (item) =>
        item.isOwn &&
        item.id.kind === 'remote' &&
        item.content.kind !== 'redacted' &&
        isEphemeralExpired(item.sentAt, policy, now),
    )
    .map((item) => item.key);
}

/**
 * When the timeline next changes on its own, in milliseconds from `now`.
 *
 * What a caller schedules a timer with, so that a conversation costs nothing
 * until something in it actually expires — rather than being redrawn every few
 * seconds against a clock, which is what a fixed interval would do to every
 * conversation in the app.
 *
 * `undefined` when nothing is left to expire. Never negative and never zero: a
 * deadline that has already passed is the caller's to apply now, and returning
 * zero would be a timer that fires in a loop.
 */
export function msUntilNextEphemeralChange(
  items: readonly AlloTimelineItem[],
  policy: AlloEphemeralPolicy,
  now: number,
): number | undefined {
  let soonest: number | undefined;
  for (const item of items) {
    if (!Number.isFinite(item.sentAt) || (!hidesContent(item) && !isRedactable(item))) {
      continue;
    }
    const expiry = ephemeralExpiryAt(item.sentAt, policy);
    if (expiry > now && (soonest === undefined || expiry < soonest)) {
      soonest = expiry;
    }
  }
  return soonest === undefined ? undefined : soonest - now;
}

/** Whether the row still shows something an expiry should take away. */
function hidesContent(item: AlloTimelineItem): boolean {
  const kind = item.content.kind;
  return kind === 'text' || kind === 'media' || kind === 'unsupported';
}

/** Whether the row is one this device will eventually ask to have redacted. */
function isRedactable(item: AlloTimelineItem): boolean {
  return item.isOwn && item.id.kind === 'remote' && item.content.kind !== 'redacted';
}
