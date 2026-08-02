import {
  ephemeralExpiryAt,
  ephemeralRedactionsDue,
  isEphemeralExpired,
  maskExpiredItems,
  msUntilNextEphemeralChange,
} from '@/lib/matrix/ephemeral/expiry';
import type { AlloEphemeralPolicy, AlloTimelineItem } from '@/lib/matrix/types';

/**
 * The deadline, and the two things that happen at it.
 *
 * Everything here takes `now` as an argument, which is the whole reason these
 * functions exist separately from the store that drives them: a deadline is a
 * comparison, and a comparison can be tested from both sides of itself instead
 * of waited for.
 */

const POLICY: AlloEphemeralPolicy = { lifetimeMs: 3_600_000 };
const SENT_AT = 1_700_000_000_000;
const EXPIRES_AT = SENT_AT + POLICY.lifetimeMs;

function item(overrides: Partial<AlloTimelineItem> = {}): AlloTimelineItem {
  return {
    key: 'row-1',
    id: { kind: 'remote', eventId: '$one' },
    sender: '@alice:allo.you',
    senderDisplayName: 'Alice',
    sentAt: SENT_AT,
    isOwn: false,
    sendState: 'sent',
    content: { kind: 'text', body: 'hello', isEdited: false },
    reactions: [],
    isReadByOthers: false,
    ...overrides,
  };
}

describe('ephemeralExpiryAt', () => {
  it('is the moment it was sent plus its lifetime', () => {
    expect(ephemeralExpiryAt(SENT_AT, POLICY)).toBe(EXPIRES_AT);
  });
});

describe('isEphemeralExpired', () => {
  it('is false one millisecond before the deadline', () => {
    expect(isEphemeralExpired(SENT_AT, POLICY, EXPIRES_AT - 1)).toBe(false);
  });

  it('is true at the deadline', () => {
    // A lifetime that has exactly run out has run out. The alternative leaves a
    // message readable for one more tick of whatever clock is asking.
    expect(isEphemeralExpired(SENT_AT, POLICY, EXPIRES_AT)).toBe(true);
  });

  it('is true after it', () => {
    expect(isEphemeralExpired(SENT_AT, POLICY, EXPIRES_AT + 1)).toBe(true);
  });

  it('is false for a row with no usable timestamp', () => {
    // Hiding a message whose age nobody could establish would be hiding it for
    // no reason anybody could state.
    expect(isEphemeralExpired(Number.NaN, POLICY, EXPIRES_AT + 1)).toBe(false);
  });
});

describe('maskExpiredItems', () => {
  it('replaces the text of an expired message', () => {
    const [masked] = maskExpiredItems([item()], POLICY, EXPIRES_AT);

    expect(masked.content).toEqual({ kind: 'expired' });
  });

  it('leaves a message that has not expired exactly as it was', () => {
    const rows = [item()];

    // The same array, not an equal one: an ordinary redraw must not remount the
    // whole conversation.
    expect(maskExpiredItems(rows, POLICY, EXPIRES_AT - 1)).toBe(rows);
  });

  it('keeps everything about the row but its content', () => {
    const [masked] = maskExpiredItems([item({ key: 'row-9', isOwn: true })], POLICY, EXPIRES_AT);

    expect(masked.key).toBe('row-9');
    expect(masked.sentAt).toBe(SENT_AT);
    expect(masked.isOwn).toBe(true);
    expect(masked.sender).toBe('@alice:allo.you');
  });

  it('hides an attachment as well as a message', () => {
    // The bytes are behind a ref the row carries. Leaving the row alone would
    // leave the picture on screen.
    const media = item({
      content: {
        kind: 'media',
        media: {
          kind: 'image',
          filename: 'IMG_1.jpg',
          caption: undefined,
          source: 'ref',
          thumbnail: undefined,
          width: undefined,
          height: undefined,
          durationMs: undefined,
          size: undefined,
        },
      },
    });

    expect(maskExpiredItems([media], POLICY, EXPIRES_AT)[0].content).toEqual({ kind: 'expired' });
  });

  it('hides an event Allo cannot draw yet', () => {
    const unsupported = item({ content: { kind: 'unsupported', description: 'm.poll.start' } });

    expect(maskExpiredItems([unsupported], POLICY, EXPIRES_AT)[0].content).toEqual({
      kind: 'expired',
    });
  });

  it('leaves a redacted row saying it was deleted', () => {
    // The stronger fact. "Expired" here would replace "gone from the homeserver"
    // with "not shown on this device", which is less true.
    const redacted = item({ content: { kind: 'redacted' } });

    expect(maskExpiredItems([redacted], POLICY, EXPIRES_AT)[0].content).toEqual({
      kind: 'redacted',
    });
  });

  it('leaves an undecryptable row saying it cannot be read here', () => {
    // A missing key is a problem the reader may have to act on, and it outlives
    // the message.
    const undecryptable = item({ content: { kind: 'undecryptable' } });

    expect(maskExpiredItems([undecryptable], POLICY, EXPIRES_AT)[0].content).toEqual({
      kind: 'undecryptable',
    });
  });

  it('masks only the rows that are past their own deadline', () => {
    const rows = [item({ key: 'old' }), item({ key: 'new', sentAt: EXPIRES_AT })];

    const masked = maskExpiredItems(rows, POLICY, EXPIRES_AT);

    expect(masked[0].content).toEqual({ kind: 'expired' });
    expect(masked[1].content).toEqual({ kind: 'text', body: 'hello', isEdited: false });
  });
});

describe('ephemeralRedactionsDue', () => {
  const own = { isOwn: true } as const;

  it("asks for the viewer's own expired message", () => {
    expect(ephemeralRedactionsDue([item({ ...own, key: 'mine' })], POLICY, EXPIRES_AT)).toEqual([
      'mine',
    ]);
  });

  it('does not ask before the deadline', () => {
    expect(ephemeralRedactionsDue([item(own)], POLICY, EXPIRES_AT - 1)).toEqual([]);
  });

  it("does not ask for somebody else's message", () => {
    // Only the sender may redact their own event. Asking for anybody else's is a
    // request the homeserver refuses, once per sweep, for ever.
    expect(ephemeralRedactionsDue([item({ isOwn: false })], POLICY, EXPIRES_AT)).toEqual([]);
  });

  it('does not ask for a message the homeserver has not accepted yet', () => {
    expect(
      ephemeralRedactionsDue(
        [item({ ...own, id: { kind: 'local', transactionId: 'txn-1' } })],
        POLICY,
        EXPIRES_AT,
      ),
    ).toEqual([]);
  });

  it('does not ask again for one already redacted', () => {
    expect(
      ephemeralRedactionsDue([item({ ...own, content: { kind: 'redacted' } })], POLICY, EXPIRES_AT),
    ).toEqual([]);
  });

  it('still asks for one this device has already stopped drawing', () => {
    // The sweeper reads the rows the timeline publishes, and in an ephemeral
    // conversation those are already masked. If masking hid a row from this, the
    // content would stay on the homeserver for ever — which is the one thing
    // this tier promises not to do.
    expect(
      ephemeralRedactionsDue([item({ ...own, content: { kind: 'expired' } })], POLICY, EXPIRES_AT),
    ).toEqual(['row-1']);
  });

  it("answers with the keys of every expired row of the viewer's", () => {
    const rows = [
      item({ ...own, key: 'a' }),
      item({ ...own, key: 'b' }),
      item({ ...own, key: 'c', sentAt: EXPIRES_AT }),
    ];

    expect(ephemeralRedactionsDue(rows, POLICY, EXPIRES_AT)).toEqual(['a', 'b']);
  });
});

describe('msUntilNextEphemeralChange', () => {
  it('is the time left on the soonest row', () => {
    const rows = [item({ sentAt: SENT_AT + 1000 }), item({ key: 'sooner' })];

    expect(msUntilNextEphemeralChange(rows, POLICY, SENT_AT)).toBe(POLICY.lifetimeMs);
  });

  it('is undefined when everything has already expired', () => {
    // Nothing left to wake up for. A timer here would be one that fires for ever
    // over a conversation nothing changes.
    expect(msUntilNextEphemeralChange([item()], POLICY, EXPIRES_AT)).toBeUndefined();
  });

  it('is undefined for a conversation with nothing in it', () => {
    expect(msUntilNextEphemeralChange([], POLICY, SENT_AT)).toBeUndefined();
  });

  it('ignores a row there is nothing left to do to', () => {
    // Somebody else's redacted message: it draws as deleted and this device
    // cannot redact it. Scheduling a wake-up for it would be a timer whose
    // firing changes nothing.
    const rows = [item({ isOwn: false, content: { kind: 'redacted' } })];

    expect(msUntilNextEphemeralChange(rows, POLICY, SENT_AT)).toBeUndefined();
  });

  it("still schedules for the viewer's own row that is only masked", () => {
    // It has stopped being drawn and has not been redacted, which is exactly the
    // row the next wake-up has to act on.
    const rows = [item({ isOwn: true, content: { kind: 'text', body: 'x', isEdited: false } })];

    expect(msUntilNextEphemeralChange(rows, POLICY, SENT_AT)).toBe(POLICY.lifetimeMs);
  });

  it('is never zero or negative', () => {
    const rows = [item({ sentAt: SENT_AT - 10 })];
    const delay = msUntilNextEphemeralChange(rows, POLICY, SENT_AT);

    expect(delay === undefined || delay > 0).toBe(true);
  });
});
