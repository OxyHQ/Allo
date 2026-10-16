import type { TimelineItemView } from '@allo/core';

import { INCOMING_FRESH_MS, type SoundCueMemory, soundCue } from '@/lib/chat/soundCue';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const RECENT = new Date(NOW - 2_000).toISOString();
const OLD = new Date(NOW - INCOMING_FRESH_MS - 1_000).toISOString();

function item(overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return {
    id: 'evt-1',
    conversationId: 'conv-1',
    seq: 3,
    senderAccountId: 'acc-alice',
    senderInstanceId: 'inst-1',
    sentAt: RECENT,
    isOwn: false,
    sendState: 'accepted',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    ...overrides,
  };
}

function own(overrides: Partial<TimelineItemView> = {}): TimelineItemView {
  return item({
    id: 'local-1',
    localKey: 'local-1',
    seq: null,
    senderAccountId: 'acc-me',
    isOwn: true,
    sendState: 'pending',
    ...overrides,
  });
}

/** Opens the screen on `before`, then hands it `after`. */
function cueAfter(before: TimelineItemView[], after: TimelineItemView[]) {
  const opened: SoundCueMemory = soundCue(null, before, NOW).memory;
  return soundCue(opened, after, NOW).cue;
}

describe('soundCue', () => {
  it('stays silent for the transcript the screen opened on, however recent', () => {
    expect(soundCue(null, [item(), own({ sendState: 'failed' })], NOW).cue).toBeNull();
  });

  it('plays incoming for a recent message from somebody else', () => {
    expect(cueAfter([], [item()])).toBe('incoming');
    expect(cueAfter([item()], [item(), item({ id: 'evt-2', seq: 4 })])).toBe('incoming');
  });

  it('stays silent for history: an old message, paging back, an edit', () => {
    expect(cueAfter([], [item({ sentAt: OLD })])).toBeNull();
    expect(
      cueAfter(
        [item({ id: 'evt-9', seq: 9 })],
        [item({ seq: 3, sentAt: OLD }), item({ id: 'evt-9', seq: 9 })],
      ),
    ).toBeNull();
    expect(
      cueAfter([item()], [item({ content: { kind: 'text', body: 'hi', isEdited: true } })]),
    ).toBeNull();
  });

  it('stays silent for what nobody said: system lines, deletions and call logs', () => {
    expect(cueAfter([], [item({ content: { kind: 'system', text: 'Ana joined' } })])).toBeNull();
    expect(cueAfter([], [item({ content: { kind: 'deleted' } })])).toBeNull();
  });

  it('plays outgoing once the server has the message, keyed across the id change', () => {
    const sent = own({ id: 'evt-7', seq: 7, sendState: 'accepted' });
    expect(cueAfter([own()], [sent])).toBe('outgoing');
    // Delivered and read later are not a second departure.
    expect(cueAfter([sent], [{ ...sent, sendState: 'delivered' }])).toBeNull();
    // Nor is a message already sent when the screen opened.
    expect(cueAfter([], [sent])).toBeNull();
  });

  it('plays failure when an own message fails, and only once', () => {
    expect(cueAfter([own()], [own({ sendState: 'failed' })])).toBe('failure');
    expect(cueAfter([own({ sendState: 'failed' })], [own({ sendState: 'failed' })])).toBeNull();
    // Failed before it was ever seen pending: still this send, if it is recent.
    expect(cueAfter([], [own({ sendState: 'failed' })])).toBe('failure');
    expect(cueAfter([], [own({ sendState: 'failed', sentAt: OLD })])).toBeNull();
  });

  it('plays one tone per change, the most important one', () => {
    const before = [own({ id: 'local-a', localKey: 'local-a' }), own()];
    const sent = own({ id: 'evt-a', localKey: 'local-a', seq: 5, sendState: 'accepted' });
    const arrived = item({ id: 'evt-6', seq: 6 });
    expect(cueAfter(before, [sent, own({ sendState: 'failed' }), arrived])).toBe('failure');
    expect(cueAfter(before.slice(0, 1), [sent, arrived])).toBe('outgoing');
  });
});
