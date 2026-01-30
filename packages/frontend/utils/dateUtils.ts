/**
 * Date utility functions for scheduling and formatting
 *
 * Formatters are cached at module scope to avoid re-creating
 * Intl.DateTimeFormat on every call (significant perf win in lists).
 */

export const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * 60000);

export const formatDateInput = (date: Date) => date.toISOString().slice(0, 10);

export const formatTimeInput = (date: Date) => date.toTimeString().slice(0, 5);

// Cached formatter — locale doesn't change during a session
let _scheduledFormatter: Intl.DateTimeFormat | null = null;
function getScheduledFormatter(): Intl.DateTimeFormat {
  if (!_scheduledFormatter) {
    _scheduledFormatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  return _scheduledFormatter;
}

export const formatScheduledLabel = (date: Date): string => {
  try {
    return getScheduledFormatter().format(date);
  } catch {
    return date.toLocaleString();
  }
};
