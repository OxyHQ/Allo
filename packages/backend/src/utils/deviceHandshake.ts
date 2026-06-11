/**
 * Device-handshake verification for the messaging Socket.IO namespace.
 *
 * Extracted as a pure, dependency-injected function so the hardening rules can
 * be unit-tested without booting Express / Socket.IO. A claimed Signal device id
 * MUST be registered to the authenticated user; an unregistered/revoked device
 * is rejected so a revoked client cannot keep a live connection after its Device
 * row is deleted. A connection that claims NO device id is allowed (legacy
 * clients) and only ever joins the user room.
 */

/** Looks up whether a (userId, deviceId) pair is a registered device. */
export type DeviceExistsFn = (userId: string, deviceId: number) => Promise<boolean>;

export interface DeviceHandshakeResult {
  /** True when the handshake is allowed to proceed. */
  ok: boolean;
  /** Resolved numeric device id when one was claimed and verified. */
  deviceId?: number;
  /** Machine-readable rejection reason when `ok` is false. */
  error?: "unauthorized" | "unregistered_device" | "device_verification_failed";
}

/**
 * Decide whether a messaging handshake may connect.
 *
 * @param userId        Authenticated user id (from the auth middleware), or undefined.
 * @param rawDeviceId   The `auth.deviceId` claimed in the handshake (any type).
 * @param deviceExists  Resolver that reports whether the device is registered.
 */
export async function verifyDeviceHandshake(
  userId: string | undefined,
  rawDeviceId: unknown,
  deviceExists: DeviceExistsFn
): Promise<DeviceHandshakeResult> {
  if (!userId) {
    return { ok: false, error: "unauthorized" };
  }

  // No device claimed → legacy client, allow (user room only).
  if (rawDeviceId === undefined || rawDeviceId === null || rawDeviceId === "") {
    return { ok: true };
  }

  const deviceId = Number(rawDeviceId);
  if (!Number.isInteger(deviceId) || deviceId < 1) {
    return { ok: false, error: "unregistered_device" };
  }

  try {
    const exists = await deviceExists(userId, deviceId);
    if (!exists) {
      return { ok: false, error: "unregistered_device" };
    }
    return { ok: true, deviceId };
  } catch {
    return { ok: false, error: "device_verification_failed" };
  }
}
