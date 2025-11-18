import mongoose, { Schema, Document } from "mongoose";

/**
 * Device model for Signal Protocol
 * Stores device keys and identity keys for each user's device
 */
export interface IDevice extends Document {
  userId: string; // Oxy user ID
  deviceId: number; // Device ID (1, 2, 3, etc.)
  identityKeyPublic: string; // Base64 encoded public identity key
  signedPreKey: {
    keyId: number;
    publicKey: string; // Base64 encoded
    signature: string; // Base64 encoded signature
  };
  preKeys: Array<{
    keyId: number;
    publicKey: string; // Base64 encoded
  }>;
  registrationId: number; // Signal registration ID
  lastSeen: Date;
  createdAt: Date;
  updatedAt: Date;
}

const SignedPreKeySchema = new Schema(
  {
    keyId: { type: Number, required: true },
    publicKey: { type: String, required: true },
    signature: { type: String, required: true },
  },
  { _id: false }
);

const PreKeySchema = new Schema(
  {
    keyId: { type: Number, required: true },
    publicKey: { type: String, required: true },
  },
  { _id: false }
);

const DeviceSchema = new Schema<IDevice>(
  {
    userId: { type: String, required: true, index: true },
    deviceId: { type: Number, required: true, min: 1 },
    identityKeyPublic: { type: String, required: true },
    signedPreKey: { type: SignedPreKeySchema, required: true },
    preKeys: [PreKeySchema],
    registrationId: { type: Number, required: true },
    lastSeen: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

// Unique constraint: one device per user+deviceId combination
DeviceSchema.index({ userId: 1, deviceId: 1 }, { unique: true });

export const Device = mongoose.model<IDevice>("Device", DeviceSchema);
export default Device;

