/**
 * THE CALL LOG, AS THE HISTORY SCREEN LISTS IT.
 *
 * The log is not a store: it IS the `call_log` messages in the conversations,
 * read through `@allo/core` and projected here into the rows Bloom's
 * `CallHistoryList` draws. Pure apart from the one hook, and `callHistorySections`
 * takes `now`, so a test can hold the clock still.
 *
 * Separate from `session.ts` because they are different things: that file is
 * the ONE live call, this one is every call that has finished.
 */
import { useMemo } from 'react';
import type { CallDirection, CallHistoryItem, CallHistorySection, CallMode } from '@oxy.so/bloom/call-ui';
import { useCallHistory } from '@allo/react';

import { formatCallDuration, formatDay, formatTime, type Translate } from '@/lib/chat/format';

/** A finished call, as the history screen lists it. */
export interface CallLogEntry {
  readonly id: string;
  readonly conversationId: string;
  readonly peerAccountIds: readonly string[];
  readonly mode: CallMode;
  readonly direction: CallDirection;
  readonly at: number;
  readonly durationMs: number;
}

/** The five ways a call can have finished, as `@allo/core` files them. */
type CallOutcome = 'answered' | 'not_answered' | 'declined' | 'cancelled' | 'failed';

/**
 * Which of Bloom's four arrows a finished call wears.
 *
 * `missed` and `declined` are READINGS of an incoming call, not facts the
 * caller asserted: the same record is an unanswered outgoing call at the other
 * end, and drawing it as "missed" there would be telling somebody they ignored
 * their own call.
 *
 * `outcome` is typed as the union rather than `string` on purpose — a sixth
 * outcome added to `CallHistoryEntry` has to be handled here instead of
 * falling through to `incoming`, which is the one case where a missed call
 * would be drawn as answered.
 */
export function directionOf(entry: { incoming: boolean; outcome: CallOutcome }): CallDirection {
  if (!entry.incoming) return 'outgoing';
  switch (entry.outcome) {
    case 'declined':
      return 'declined';
    case 'not_answered':
    case 'cancelled':
      return 'missed';
    case 'answered':
    case 'failed':
      return 'incoming';
  }
}

/** The call log, read out of the conversations where it lives. */
export function useCallLog(): readonly CallLogEntry[] {
  const history = useCallHistory();
  return useMemo(
    () =>
      history.map((entry) => ({
        id: entry.id,
        conversationId: entry.conversationId,
        peerAccountIds: entry.withAccountIds,
        mode: entry.mode,
        direction: directionOf(entry),
        at: Date.parse(entry.at),
        durationMs: entry.durationMs,
      })),
    [history],
  );
}

/** What the history screen needs to turn a log entry into a row. */
export interface CallHistoryCopy {
  readonly now: Date;
  readonly locale: string;
  readonly t: Translate;
  /** The people on the call, as one name. */
  readonly nameFor: (accountIds: readonly string[]) => string;
  /** An Oxy file id or a URL for the row's avatar, when there is one. */
  readonly avatarFor: (accountIds: readonly string[]) => string | undefined;
}

/**
 * The log as Bloom's day-headed sections.
 *
 * Every string a `CallHistoryRow` draws is decided here: the day heading, the
 * second line and the direction word. Bloom formats nothing, because what
 * "yesterday" means needs a locale and a timezone a component does not have.
 * The second line is the clock time and, for a call that connected, how long it
 * ran — `"18:40 · 04:32"`; the row prefixes the direction word itself.
 */
export function callHistorySections(
  entries: readonly CallLogEntry[],
  copy: CallHistoryCopy,
): CallHistorySection[] {
  const sections: { id: string; title: string; items: CallHistoryItem[] }[] = [];
  for (const entry of [...entries].sort((a, b) => b.at - a.at)) {
    const at = new Date(entry.at);
    const title = formatDay(at, copy.now, copy.locale, copy.t);
    const time = formatTime(at, copy.locale);
    const meta = entry.durationMs > 0 ? `${time} · ${formatCallDuration(entry.durationMs)}` : time;

    const item: CallHistoryItem = {
      id: entry.id,
      name: copy.nameFor(entry.peerAccountIds),
      avatar: copy.avatarFor(entry.peerAccountIds),
      direction: entry.direction,
      mode: entry.mode,
      meta,
    };

    const last = sections.at(-1);
    if (last !== undefined && last.title === title) last.items.push(item);
    else sections.push({ id: `${title}-${entry.id}`, title, items: [item] });
  }
  return sections;
}
