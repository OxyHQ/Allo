/**
 * The numbers a voice note and a document put on screen.
 *
 * All pure, and separate from the components for the reason `messageStatus.ts`
 * is: these are the parts a reader checks against the clock in their hand. A
 * voice note that says 0:07 and plays for a minute, or a duration in
 * milliseconds shown as seconds, is a bug nobody reports because it looks like
 * a working player.
 */

const MILLISECONDS_PER_SECOND = 1000;
const SECONDS_PER_MINUTE = 60;
const MINUTES_PER_HOUR = 60;

/**
 * A position or a duration, as a clock.
 *
 * `m:ss` under an hour and `h:mm:ss` above it — a voice note is seconds long
 * and a leading `0:` on all of them is noise, while an hour-long recording
 * shown as `73:20` is a number the reader has to divide.
 *
 * Rounded **down**. A player one millisecond into a seven-second note is at
 * 0:00, not 0:01: counting up from a number the user has not reached yet makes
 * the last second of every recording appear to be missing.
 */
export function formatPlaybackTime(milliseconds: number): string {
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    return '0:00';
  }
  const totalSeconds = Math.floor(milliseconds / MILLISECONDS_PER_SECOND);
  const seconds = totalSeconds % SECONDS_PER_MINUTE;
  const totalMinutes = Math.floor(totalSeconds / SECONDS_PER_MINUTE);
  const minutes = totalMinutes % MINUTES_PER_HOUR;
  const hours = Math.floor(totalMinutes / MINUTES_PER_HOUR);

  const paddedSeconds = seconds.toString().padStart(2, '0');
  if (hours === 0) {
    return `${minutes}:${paddedSeconds}`;
  }
  return `${hours}:${minutes.toString().padStart(2, '0')}:${paddedSeconds}`;
}

/**
 * How far through the recording the player is, from 0 to 1.
 *
 * Zero when the duration is not known yet, which is the state a player is in
 * for the moment between being handed a file and having read its header. A
 * progress bar that jumps to full and back because it divided by zero is worse
 * than one that starts empty.
 */
export function playbackFraction(positionMs: number, durationMs: number): number {
  if (!Number.isFinite(positionMs) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const fraction = positionMs / durationMs;
  return fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
}

/**
 * Where a scrub to this fraction of the bar lands, in milliseconds.
 *
 * The inverse of {@link playbackFraction}, and clamped at both ends for the
 * same reason: a slider reports 1.0000000001 often enough, and seeking past the
 * end of a file is an error on some platforms and silence on others.
 */
export function seekPositionMs(fraction: number, durationMs: number): number {
  if (!Number.isFinite(fraction) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return 0;
  }
  const clamped = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction;
  return Math.round(clamped * durationMs);
}

/**
 * The length to show, from what the file says and what the sender claimed.
 *
 * The player wins whenever it has read one, because it measured the bytes that
 * are actually here. The event's `info.duration` is the sender's client talking
 * and is the only number available before a byte has been downloaded — which is
 * most of the time a voice note is on screen, since nothing is fetched until it
 * is played. Neither is always present; zero from either is "not known".
 */
export function displayDurationMs(
  loadedDurationMs: number | undefined,
  claimedDurationMs: number | undefined,
): number {
  const loaded = toPositiveMilliseconds(loadedDurationMs);
  if (loaded !== undefined) {
    return loaded;
  }
  return toPositiveMilliseconds(claimedDurationMs) ?? 0;
}

function toPositiveMilliseconds(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : undefined;
}

const BYTES_PER_UNIT = 1024;
/** SI-prefixed but binary-based, which is what every file manager on a phone shows. */
const SIZE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * A file size, as a document row shows it.
 *
 * One decimal above a kilobyte and none below: "1.4 MB" is the size, "1433.6 B"
 * is a measurement. `undefined` for a size nobody reported — an `m.file` whose
 * sender left `info.size` out — because "0 B" is a claim about the file and an
 * absent line is not.
 */
export function formatFileSize(bytes: number | undefined): string | undefined {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) {
    return undefined;
  }
  let size = bytes;
  let unit = 0;
  while (size >= BYTES_PER_UNIT && unit < SIZE_UNITS.length - 1) {
    size /= BYTES_PER_UNIT;
    unit += 1;
  }
  const rounded = unit === 0 ? Math.round(size) : Math.round(size * 10) / 10;
  return `${rounded} ${SIZE_UNITS[unit]}`;
}
