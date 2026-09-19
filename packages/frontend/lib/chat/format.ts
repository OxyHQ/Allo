/**
 * Dates and durations as the chat screens print them.
 *
 * Bloom's chat components compute nothing — every time, day, "yesterday" and
 * call length arrives as a string — so the locale and the clock are read here
 * and only here. Each function takes `now` so a test can hold the clock still.
 */

export type Translate = (key: string, options?: Record<string, unknown>) => string;

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

/** Whole calendar days from `date` to `now`, in local time. */
function daysAgo(date: Date, now: Date): number {
  return Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS);
}

/** `yyyy-mm-dd` in local time: what decides where a day separator goes. */
export function dayKey(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/** `14:05`, in the locale's own clock. */
export function formatTime(date: Date, locale: string): string {
  return date.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' });
}

/** A day separator: Today, Yesterday, a weekday this week, then a date. */
export function formatDay(date: Date, now: Date, locale: string, t: Translate): string {
  const days = daysAgo(date, now);
  if (days === 0) return t('chat.day.today');
  if (days === 1) return t('chat.day.yesterday');
  if (days > 1 && days < 7) return date.toLocaleDateString(locale, { weekday: 'long' });
  const sameYear = date.getFullYear() === now.getFullYear();
  return date.toLocaleDateString(locale, sameYear
    ? { day: 'numeric', month: 'long' }
    : { day: 'numeric', month: 'long', year: 'numeric' });
}

/**
 * How long a call ran: `"00:42"`, `"12:07"`, `"1:04:11"` — the hour appears
 * only once there is one.
 *
 * The SAME string on the live call and in the log. They were two functions
 * that disagreed about padding, so a call showed `4:32` while it was running
 * and `04:32` in the history row a second later.
 */
export function formatCallDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (value: number) => String(value).padStart(2, '0');
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor(total / 60) % 60;
  const seconds = total % 60;
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

/** A conversation row's time: the clock today, a weekday this week, then a short date. */
export function formatListTime(date: Date, now: Date, locale: string, t: Translate): string {
  const days = daysAgo(date, now);
  if (days === 0) return formatTime(date, locale);
  if (days === 1) return t('chat.day.yesterday');
  if (days > 1 && days < 7) return date.toLocaleDateString(locale, { weekday: 'short' });
  return date.toLocaleDateString(locale, { day: 'numeric', month: 'numeric', year: '2-digit' });
}
