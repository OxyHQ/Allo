/**
 * Shared types for multi-device, per-device-envelope encrypted messaging.
 *
 * In the envelope model (encryption version 3) a single logical message is
 * fanned out into one opaque ciphertext per recipient *device*. The backend
 * only ever stores and forwards these opaque ciphertexts — it never sees
 * plaintext. Each device hydrates its own envelope on delivery.
 */

/** Wrapped (per-device) symmetric key for an encrypted media attachment. */
export interface EnvelopeMediaKey {
  /** Identifier of the media item this key unlocks. */
  mediaId: string;
  /** Base64-encoded media key, wrapped for the recipient device's session. */
  wrappedKey: string;
}

/**
 * A single per-device envelope produced by the sender for one recipient device.
 * The sender produces one of these for every active device of every conversation
 * participant (including the sender's own other devices).
 */
export interface MessageEnvelopeDTO {
  /** Oxy user ID of the recipient. */
  recipientUserId: string;
  /** Signal device ID of the recipient device (positive integer). */
  recipientDeviceId: number;
  /** Base64-encoded Signal wire-format ciphertext for this device. */
  ciphertext: string;
  /** Optional per-device wrapped media keys for attachments. */
  mediaKeys?: EnvelopeMediaKey[];
}

/** A (user, device) pair addressing a single Signal device. */
export interface DeviceTarget {
  userId: string;
  deviceId: number;
}

/**
 * Public, non-secret information about a device, returned to clients so they
 * can build the device list they must encrypt to. Never includes prekeys.
 */
export interface DevicePublicInfo {
  deviceId: number;
  identityKeyPublic: string;
  deviceName?: string;
  platform?: "ios" | "android" | "web";
  /** ISO-8601 timestamp of the device's last activity. */
  lastSeen?: string;
}

/** Encryption version that carries per-device envelopes instead of one blob. */
export const ENCRYPTION_VERSION_ENVELOPES = 3;
