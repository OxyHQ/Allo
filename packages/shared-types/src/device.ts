/**
 * Shared device / Signal Protocol key transport DTOs for Allo.
 *
 * The wire shape the devices routes exchange, composed by
 * `packages/backend/src/utils/deviceDto.ts` from the Postgres rows.
 *
 * These carry `id` and NOT the `_id` alias its conversation and message
 * siblings keep: no client reads a device's own row id under either spelling
 * (they address a device by Signal's `deviceId`), so there is no shipped
 * reader to keep working and the rename is a clean cut.
 */

/**
 * Signed pre-key bundle entry (Base64 encoded values).
 */
export interface SignedPreKey {
  keyId: number;
  publicKey: string;
  signature: string;
}

/**
 * One-time pre-key entry (Base64 encoded values).
 */
export interface PreKey {
  keyId: number;
  publicKey: string;
}

/**
 * Serialized device record returned by the devices API.
 */
export interface DeviceDto {
  id: string;
  userId: string;
  /** Signal's own device number, 1-based and unique only within a user. */
  deviceId: number;
  /** Base64 encoded public identity key. */
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  preKeys?: PreKey[];
  registrationId: number;
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Public device bundle returned for key exchange
 * (`GET /api/devices/user/:userId`) — excludes one-time pre-keys.
 */
export interface PublicDeviceBundle {
  id: string;
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  registrationId: number;
}
