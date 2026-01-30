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

// Cached formatters for conversation timestamps
let _timeFormatter: Intl.DateTimeFormat | null = null;
function getTimeFormatter(): Intl.DateTimeFormat {
  if (!_timeFormatter) {
    _timeFormatter = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return _timeFormatter;
}

let _weekdayFormatter: Intl.DateTimeFormat | null = null;
function getWeekdayFormatter(): Intl.DateTimeFormat {
  if (!_weekdayFormatter) {
    _weekdayFormatter = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  }
  return _weekdayFormatter;
}

let _shortDateFormatter: Intl.DateTimeFormat | null = null;
function getShortDateFormatter(): Intl.DateTimeFormat {
  if (!_shortDateFormatter) {
    _shortDateFormatter = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
  }
  return _shortDateFormatter;
}

/**
 * Formats a conversation timestamp in WhatsApp style:
 *  - Today:      "10:30 AM"
 *  - Yesterday:  "Yesterday"
 *  - This week:  "Monday"
 *  - Older:      "1/15/25"
 */
export const formatConversationTimestamp = (input: string | Date): string => {
  try {
    const date = typeof input === 'string' ? new Date(input) : input;
    const now = new Date();

    // Start of today (midnight)
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfYesterday = new Date(startOfToday.getTime() - 86400000);
    const startOfWeek = new Date(startOfToday.getTime() - 6 * 86400000);

    if (date >= startOfToday) {
      return getTimeFormatter().format(date);
    }
    if (date >= startOfYesterday) {
      return 'Yesterday';
    }
    if (date >= startOfWeek) {
      return getWeekdayFormatter().format(date);
    }
    return getShortDateFormatter().format(date);
  } catch {
    return '';
  }
};
