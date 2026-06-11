/**
 * Single source of truth for multi-device + per-device-envelope lifecycle.
 *
 * These constants are deliberately co-located so the lifecycle invariant is
 * visible in one place:
 *
 *   ENVELOPE_DELIVERED_RETENTION_DAYS  <=  DEVICE_INACTIVE_DAYS  <=  DEVICE_DELETE_DAYS
 *
 * Rationale:
 *  - A device that has already received (delivered) an envelope only needs it
 *    kept around briefly for multi-device read-receipt / re-sync — hence the
 *    shortest horizon.
 *  - A device is considered "inactive" (excluded from default fan-out) after it
 *    stops checking in; senders should stop encrypting to it once it crosses
 *    this horizon, so the delivered-retention window must not outlive it.
 *  - A device is only hard-deleted (keys discarded) after the longest horizon,
 *    giving it a chance to come back before it must fully re-register.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days an undelivered envelope is retained before TTL reaps it. */
export const ENVELOPE_RETENTION_DAYS = 90;

/** Days a delivered envelope is retained (shortened TTL after delivery). */
export const ENVELOPE_DELIVERED_RETENTION_DAYS = 30;

/** A device with no activity within this many days is treated as inactive. */
export const DEVICE_INACTIVE_DAYS = 30;

/** A device with no activity within this many days is lazily hard-deleted. */
export const DEVICE_DELETE_DAYS = 90;

/** Minimum interval between throttled `lastSeen` writes for a connected device. */
export const DEVICE_LAST_SEEN_THROTTLE_MS = 60 * 1000;

/** Maximum number of device targets accepted by the batch prekey endpoint. */
export const PREKEY_BATCH_MAX_TARGETS = 500;

/** Maximum length of a user-provided device name. */
export const DEVICE_NAME_MAX_LENGTH = 64;

/** Convert a day count to milliseconds. */
export function days(count: number): number {
  return count * DAY_MS;
}

/** A Date `count` days in the future from `from` (default now). */
export function daysFromNow(count: number, from: Date = new Date()): Date {
  return new Date(from.getTime() + days(count));
}

/** A Date `count` days in the past from `from` (default now). */
export function daysAgo(count: number, from: Date = new Date()): Date {
  return new Date(from.getTime() - days(count));
}

/** Minimal activity shape needed to decide if a device is active. */
export interface DeviceActivity {
  lastSeen?: Date;
  createdAt?: Date;
}

/**
 * Single source of truth for "is this device active?". A device counts as active
 * if its `lastSeen` (or, for a freshly-registered device that hasn't checked in
 * yet, its `createdAt`) falls within DEVICE_INACTIVE_DAYS. Used by both the
 * fan-out consistency check and the device-list endpoint so they never diverge.
 */
export function isActiveDevice(
  device: DeviceActivity,
  cutoff: Date = daysAgo(DEVICE_INACTIVE_DAYS)
): boolean {
  const reference = device.lastSeen ?? device.createdAt;
  return reference instanceof Date ? reference >= cutoff : true;
}

// Compile-time-ish safety net: assert the lifecycle invariant holds. If a future
// edit breaks the ordering, the module throws on import (fail fast in dev/CI).
if (
  !(
    ENVELOPE_DELIVERED_RETENTION_DAYS <= DEVICE_INACTIVE_DAYS &&
    DEVICE_INACTIVE_DAYS <= DEVICE_DELETE_DAYS
  )
) {
  throw new Error(
    "multiDevice lifecycle invariant violated: expected " +
      "ENVELOPE_DELIVERED_RETENTION_DAYS <= DEVICE_INACTIVE_DAYS <= DEVICE_DELETE_DAYS"
  );
}
