/**
 * The words for somebody's presence, and nothing else.
 *
 * The state itself comes from `usePresence` in `@allo/react`, which is a watch
 * set: a screen says which accounts it is DRAWING and hears about those. This
 * file is the projection — what a dot and a line of text say — and is pure, so
 * it is tested without a client.
 *
 * Two things the platform deliberately does not model, and so neither does
 * this: **idle** and **busy**. A heartbeat can say somebody's device is
 * connected; it cannot say they are at their desk. Bloom draws four states and
 * Allo uses two of them.
 *
 * And one thing it does model, which the UI must not flatten: an account that
 * is `known: false` has not been answered for yet, which is not the same as
 * offline. Drawing an unanswered account as away is how a list flashes
 * everybody grey on every cold start.
 */
import type { PresenceStatus } from '@oxy.so/bloom/chat-indicators';
import type { PresenceView } from '@allo/react';

/** Wording is the caller's; this file only decides which sentence to ask for. */
type Translate = (key: string, options?: Record<string, unknown>) => string;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * The dot, or nothing at all.
 *
 * `undefined` for an account nobody has answered for and for one that is
 * offline: Allo draws a dot when somebody is there and draws none when they
 * are not, rather than a grey dot that reads as "away".
 */
export function presenceDot(presence: PresenceView): PresenceStatus | undefined {
  return presence.known && presence.online ? 'online' : undefined;
}

/**
 * The line under a name: "online", "last seen 20 minutes ago", or nothing.
 *
 * Nothing is the answer for an account that has not been answered for, one
 * that hides its presence, one that blocked you and one that has simply never
 * been seen — the platform makes those indistinguishable on purpose, and a
 * screen that invented a difference would undo it.
 */
export function presenceLine(presence: PresenceView, copy: { t: Translate; locale: string; now: Date }): string | undefined {
  if (!presence.known) return undefined;
  if (presence.online) return copy.t('presence.online');
  if (!presence.lastSeenAt) return undefined;

  const at = new Date(presence.lastSeenAt);
  const elapsed = copy.now.getTime() - at.getTime();
  if (Number.isNaN(at.getTime()) || elapsed < 0) return undefined;

  if (elapsed < 2 * MINUTE) return copy.t('presence.lastSeen.justNow');
  if (elapsed < HOUR) return copy.t('presence.lastSeen.minutes', { count: Math.round(elapsed / MINUTE) });
  if (elapsed < DAY) return copy.t('presence.lastSeen.hours', { count: Math.floor(elapsed / HOUR) });
  if (elapsed < 2 * DAY) return copy.t('presence.lastSeen.yesterday');
  return copy.t('presence.lastSeen.on', {
    date: new Intl.DateTimeFormat(copy.locale, { day: 'numeric', month: 'short' }).format(at),
  });
}
