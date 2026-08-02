import {
  displayDurationMs,
  formatFileSize,
  formatPlaybackTime,
  playbackFraction,
  seekPositionMs,
} from '@/components/messages/attachmentFormat';

/**
 * The numbers under a voice note and a document.
 *
 * Every one of them is checked by the reader against something real — the clock
 * in their hand, the file they are about to download — so being wrong here is
 * being wrong visibly. And every one of them is a place a unit slips: the port
 * speaks milliseconds, `expo-audio` speaks seconds, and a player that divides by
 * a duration it does not have yet draws a bar that jumps to the end and back.
 */

describe('a position on the clock', () => {
  it('shows seconds with a leading zero and minutes without one', () => {
    expect(formatPlaybackTime(7_000)).toBe('0:07');
    expect(formatPlaybackTime(65_000)).toBe('1:05');
  });

  it('rounds down, so a player barely started is not already past a second', () => {
    // Counting up from a second the user has not reached makes the last second
    // of every recording look missing.
    expect(formatPlaybackTime(6_999)).toBe('0:06');
  });

  it('adds hours only when there are some', () => {
    // A voice note is seconds long; a leading `0:` on all of them is noise.
    expect(formatPlaybackTime(3_600_000)).toBe('1:00:00');
    expect(formatPlaybackTime(4_400_000)).toBe('1:13:20');
  });

  it('is zero before anything has played', () => {
    expect(formatPlaybackTime(0)).toBe('0:00');
  });

  it('is zero rather than nonsense for a length nothing measured', () => {
    expect(formatPlaybackTime(Number.NaN)).toBe('0:00');
    expect(formatPlaybackTime(-500)).toBe('0:00');
  });
});

describe('how far through the bar is', () => {
  it('is the position over the length', () => {
    expect(playbackFraction(2_500, 10_000)).toBe(0.25);
  });

  it('is empty before the length is known', () => {
    // The state between handing the player a file and its having read the
    // header. A bar that divided by zero would jump to full and back.
    expect(playbackFraction(2_500, 0)).toBe(0);
  });

  it('never goes past full', () => {
    expect(playbackFraction(12_000, 10_000)).toBe(1);
  });

  it('never goes below empty', () => {
    expect(playbackFraction(-1, 10_000)).toBe(0);
  });
});

describe('where a scrub lands', () => {
  it('is the fraction of the length, in milliseconds', () => {
    expect(seekPositionMs(0.25, 10_000)).toBe(2_500);
  });

  it('is the inverse of the fraction the bar draws', () => {
    expect(seekPositionMs(playbackFraction(3_300, 9_000), 9_000)).toBe(3_300);
  });

  it('never seeks past the end of the file', () => {
    // Seeking past the end is an error on some platforms and silence on others.
    // Asserted with a fraction the rounding cannot absorb: `1.0000001` lands on
    // the last millisecond either way, so it proves nothing about the clamp.
    expect(seekPositionMs(1.5, 10_000)).toBe(10_000);
  });

  it('never seeks before the beginning', () => {
    expect(seekPositionMs(-0.5, 10_000)).toBe(0);
  });

  it('is the beginning when there is no length to scrub through', () => {
    expect(seekPositionMs(0.5, 0)).toBe(0);
  });
});

describe('which length to show', () => {
  it('prefers what the player measured', () => {
    // The player read the bytes that are actually here; the event is the
    // sender's client talking.
    expect(displayDurationMs(7_400, 7_000)).toBe(7_400);
  });

  it("falls back to the sender's claim before anything is downloaded", () => {
    // Which is most of the time a voice note is on screen: nothing is fetched
    // until play is pressed, so the event is the only length there is.
    expect(displayDurationMs(undefined, 7_000)).toBe(7_000);
  });

  it('treats a player that reports zero as not knowing yet', () => {
    // `AudioStatus.duration` is 0 until the header has been read, and zero
    // shown as a length puts "0:00" under a recording that is seven seconds
    // long.
    expect(displayDurationMs(0, 7_000)).toBe(7_000);
  });

  it('is zero when neither has a length', () => {
    expect(displayDurationMs(undefined, undefined)).toBe(0);
  });
});

describe('a file size', () => {
  it('shows bytes whole', () => {
    // "1023 B" is a size; "1023.0 B" is a measurement.
    expect(formatFileSize(1_023)).toBe('1023 B');
  });

  it('shows one decimal above a kilobyte', () => {
    expect(formatFileSize(1_536)).toBe('1.5 KB');
    expect(formatFileSize(1_468_006)).toBe('1.4 MB');
  });

  it('climbs a unit at a time', () => {
    expect(formatFileSize(1024 ** 3)).toBe('1 GB');
  });

  it('says nothing at all when the sender did not say', () => {
    // "0 B" is a claim about the file. An absent line is not.
    expect(formatFileSize(undefined)).toBeUndefined();
  });

  it('says nothing for a size that is not one', () => {
    expect(formatFileSize(-1)).toBeUndefined();
    expect(formatFileSize(Number.NaN)).toBeUndefined();
  });

  it('shows an empty file as empty', () => {
    expect(formatFileSize(0)).toBe('0 B');
  });
});
