/**
 * The device wire shapes, composed in ONE place.
 *
 * There are two of them and the split is a privacy boundary, not a convenience:
 * {@link toDeviceDto} is what a user sees of their OWN device, and
 * {@link toPublicDeviceBundle} is what a stranger gets for key exchange. Mongo
 * drew the same line with `.select("deviceId identityKeyPublic signedPreKey
 * registrationId")`, a string that no compiler ever checked.
 *
 * ## One-time pre-keys are omitted by CONSTRUCTION, not by a flag
 *
 * `GET /api/devices` excluded them with `.select("-preKeys")`. Here
 * {@link toDeviceDto} takes a `DeviceRecord`, whose type has no `preKeys`
 * property at all, so the list route cannot emit them even by mistake; only
 * {@link toDeviceWithPreKeysDto} accepts the `DeviceWithPreKeys` the two paths
 * entitled to them load. A single function with an optional argument would put
 * that guarantee back in the caller's hands, which is where it was when it was
 * a string.
 */

import type { DeviceDto, PublicDeviceBundle } from "@allo/shared-types";
import type {
  DeviceBundle,
  DeviceRecord,
  DeviceWithPreKeys,
} from "../db/messaging/deviceRepository";

/** The caller's own device, WITHOUT its one-time pre-keys. */
export function toDeviceDto(device: DeviceRecord): DeviceDto {
  return {
    id: device.id,
    userId: device.userId,
    deviceId: device.deviceId,
    identityKeyPublic: device.identityKeyPublic,
    signedPreKey: device.signedPreKey,
    registrationId: device.registrationId,
    lastSeen: device.lastSeen,
    createdAt: device.createdAt,
    updatedAt: device.updatedAt,
  };
}

/**
 * The caller's own device WITH its one-time pre-keys — the register, update and
 * single-device reads, which are the three paths Mongo returned them on.
 */
export function toDeviceWithPreKeysDto(device: DeviceWithPreKeys): DeviceDto {
  return { ...toDeviceDto(device), preKeys: [...device.preKeys] };
}

/**
 * Somebody else's device, as a key-exchange bundle.
 *
 * No `userId` and no timestamps: the caller already knows whose devices they
 * asked for, and `lastSeen` would report when that person was last online to
 * anyone willing to ask.
 */
export function toPublicDeviceBundle(bundle: DeviceBundle): PublicDeviceBundle {
  return {
    id: bundle.id,
    deviceId: bundle.deviceId,
    identityKeyPublic: bundle.identityKeyPublic,
    signedPreKey: bundle.signedPreKey,
    registrationId: bundle.registrationId,
  };
}
