/**
 * Shared device / Signal Protocol key transport DTOs for Allo.
 *
 * Mirrors the serialized shape of the `Device` mongoose model
 * (`packages/backend/src/models/Device.ts`) as exchanged by the
 * devices routes (`packages/backend/src/routes/devices.ts`).
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
  _id?: unknown;
  userId: string;
  deviceId: number;
  /** Base64 encoded public identity key. */
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  preKeys?: PreKey[];
  registrationId: number;
  lastSeen?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

/**
 * Public device bundle returned for key exchange
 * (`GET /api/devices/user/:userId`) — excludes one-time pre-keys.
 */
export interface PublicDeviceBundle {
  _id?: unknown;
  deviceId: number;
  identityKeyPublic: string;
  signedPreKey: SignedPreKey;
  registrationId: number;
}
