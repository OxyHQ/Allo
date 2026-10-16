import type { SendState, TimelineItemView } from '@allo/core';

/**
 * Which tone a change to the open transcript earns, if any. Pure: the screen
 * hands it what it remembered and the items it now has, and keeps what comes
 * back for next time.
 *
 * - `outgoing`: an own message the server has just taken (`pending` → accepted
 *   or later). The tone says "it left", so it waits for that rather than for
 *   the press.
 * - `failure`: an own message that has just failed.
 * - `incoming`: a message from somebody else, new to this screen and RECENT.
 *   Opening a conversation, paging back, a history transfer or a backlog synced
 *   after a while offline all bring items this screen has not seen; none of
 *   them is a message arriving, and the age bound is what tells them apart.
 *
 * One tone per change, the most important first, so a burst plays once.
 */
export type SoundCue = 'incoming' | 'outgoing' | 'failure';

/** What {@link soundCue} remembers between two looks at the same transcript. */
export interface SoundCueMemory {
  /** Each own message's send state, by the key that survives the server's acceptance. */
  readonly own: ReadonlyMap<string, SendState>;
  /** Every message from somebody else already seen. */
  readonly others: ReadonlySet<string>;
}

/** A message from somebody else older than this is history arriving, not a message arriving. */
export const INCOMING_FRESH_MS = 30_000;

/** What somebody can say. A call has its own ring; the rest are not a message. */
const AUDIBLE_KINDS: ReadonlySet<string> = new Set([
  'text',
  'media',
  'poll',
  'location',
  'contact',
  'sticker',
]);

const LEFT: ReadonlySet<SendState> = new Set<SendState>(['accepted', 'delivered', 'read']);

const RANK: Record<SoundCue, number> = { incoming: 1, outgoing: 2, failure: 3 };

/** `localKey` is kept once the server has the message, so it outlives the id change. */
function keyOf(item: TimelineItemView): string {
  return item.localKey ?? item.id;
}

function isRecent(item: TimelineItemView, now: number): boolean {
  const sent = Date.parse(item.sentAt);
  return Number.isFinite(sent) && now - sent <= INCOMING_FRESH_MS;
}

/**
 * `memory` is `null` the first time: the transcript as the screen opened is
 * remembered and nothing sounds.
 */
export function soundCue(
  memory: SoundCueMemory | null,
  items: readonly TimelineItemView[],
  now: number,
): { cue: SoundCue | null; memory: SoundCueMemory } {
  const own = new Map<string, SendState>();
  const others = new Set<string>();
  let cue: SoundCue | null = null;
  const raise = (next: SoundCue) => {
    if (cue === null || RANK[next] > RANK[cue]) cue = next;
  };
  for (const item of items) {
    const key = keyOf(item);
    if (item.isOwn) {
      own.set(key, item.sendState);
      if (!memory) continue;
      const before = memory.own.get(key);
      if (item.sendState === 'failed' && before !== 'failed') {
        if (before !== undefined || isRecent(item, now)) raise('failure');
      } else if (before === 'pending' && LEFT.has(item.sendState)) {
        raise('outgoing');
      }
      continue;
    }
    others.add(key);
    if (
      memory &&
      !memory.others.has(key) &&
      AUDIBLE_KINDS.has(item.content.kind) &&
      isRecent(item, now)
    )
      raise('incoming');
  }
  return { cue, memory: { own, others } };
}
