/**
 * The call log, as the history screen reads it.
 *
 * Pinned here because these are the decisions, not the drawing: how long a
 * call is SPELLED, which of Bloom's four arrows a finished call wears, and how
 * the rows fall into days. Rendering is not covered and cannot be — a Bloom
 * chat surface under jest dies in reanimated's native worklets — so the
 * screens are checked in a browser.
 */
import { formatCallDuration } from '@/lib/chat/format';
import { callHistorySections, directionOf, type CallLogEntry } from '@/lib/calls/history';

const ANA = '6700000000000000000000a2';
const TEODOR = '6700000000000000000000a3';

describe('formatCallDuration', () => {
  it('shows the hour only once there is one', () => {
    expect(formatCallDuration(0)).toBe('00:00');
    expect(formatCallDuration(42_000)).toBe('00:42');
    expect(formatCallDuration(12 * 60_000 + 7_000)).toBe('12:07');
    expect(formatCallDuration(3_600_000 + 4 * 60_000 + 11_000)).toBe('1:04:11');
  });

  it('never counts backwards', () => {
    expect(formatCallDuration(-5_000)).toBe('00:00');
  });
});

describe('directionOf', () => {
  it('files a call WE placed and nobody took as outgoing, never missed', () => {
    expect(directionOf({ incoming: false, outcome: 'not_answered' })).toBe('outgoing');
    expect(directionOf({ incoming: false, outcome: 'declined' })).toBe('outgoing');
    expect(directionOf({ incoming: false, outcome: 'cancelled' })).toBe('outgoing');
  });

  it('reads an unanswered incoming call as missed, and a refused one as declined', () => {
    expect(directionOf({ incoming: true, outcome: 'not_answered' })).toBe('missed');
    expect(directionOf({ incoming: true, outcome: 'cancelled' })).toBe('missed');
    expect(directionOf({ incoming: true, outcome: 'declined' })).toBe('declined');
  });

  it('keeps the two connected directions apart', () => {
    expect(directionOf({ incoming: true, outcome: 'answered' })).toBe('incoming');
    expect(directionOf({ incoming: false, outcome: 'answered' })).toBe('outgoing');
  });
});

describe('callHistorySections', () => {
  const NOW = new Date('2026-09-18T20:00:00');
  const t = (key: string) => key;
  const copy = {
    now: NOW,
    locale: 'en-US',
    t,
    nameFor: (ids: readonly string[]) => (ids.length === 1 ? 'Ana Restrepo' : 'Ana and 1 more'),
    avatarFor: (ids: readonly string[]) => (ids.length === 1 ? 'ana' : undefined),
  };

  const entry = (overrides: Partial<CallLogEntry> = {}): CallLogEntry => ({
    id: 'e1',
    conversationId: ANA,
    peerAccountIds: [ANA],
    mode: 'voice',
    direction: 'outgoing',
    at: new Date('2026-09-18T09:14:00').getTime(),
    durationMs: 0,
    ...overrides,
  });

  it('groups by day, newest first, with one heading per day', () => {
    const sections = callHistorySections(
      [
        entry({ id: 'older', at: new Date('2026-09-17T18:40:00').getTime() }),
        entry({ id: 'newer', at: new Date('2026-09-18T11:00:00').getTime() }),
        entry({ id: 'newest', at: new Date('2026-09-18T19:00:00').getTime() }),
      ],
      copy,
    );

    expect(sections.map((section) => section.title)).toEqual([
      'chat.day.today',
      'chat.day.yesterday',
    ]);
    expect(sections[0].items.map((item) => item.id)).toEqual(['newest', 'newer']);
    expect(sections[1].items.map((item) => item.id)).toEqual(['older']);
  });

  it('puts the length on the second line only when the call connected', () => {
    const [today] = callHistorySections(
      [entry({ id: 'missed', durationMs: 0 }), entry({ id: 'talked', durationMs: 272_000 })],
      copy,
    );
    const meta = Object.fromEntries(today.items.map((item) => [item.id, item.meta]));

    expect(meta.missed).not.toContain('·');
    // The same spelling as the live timer on the call screen: a log entry is
    // that timer's last value, and two formats for one number is how "4:32"
    // and "04:32" end up on screen a tap apart. They are now one function.
    expect(meta.talked).toContain('· 04:32');
  });

  it('draws an avatar for one person and none for a group', () => {
    const [today] = callHistorySections(
      [entry({ id: 'solo' }), entry({ id: 'group', peerAccountIds: [ANA, TEODOR] })],
      copy,
    );
    const items = Object.fromEntries(today.items.map((item) => [item.id, item]));

    expect(items.solo.avatar).toBe('ana');
    expect(items.group.avatar).toBeUndefined();
    expect(items.group.name).toBe('Ana and 1 more');
  });

  it('is empty for an empty log', () => {
    expect(callHistorySections([], copy)).toEqual([]);
  });
});
