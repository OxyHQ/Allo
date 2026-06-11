import mongoose, { Schema, Document } from "mongoose";
import type { Network } from "@allo/shared-types";

/**
 * A contact an Allo user can reach on an external network. Upserted from inbound
 * bridge `message` events (the sender becomes a known contact) and read by the
 * user-facing bridge routes to start conversations / show contact metadata.
 *
 * One row per (ownerUserId, network, externalId).
 */
export interface IExternalContact extends Document {
  ownerUserId: string; // Oxy user ID that owns this contact list
  network: Network;
  externalId: string; // The contact's id on the external network
  displayName?: string;
  username?: string;
  avatarUrl?: string;
  phoneHint?: string;
  createdAt: Date;
  updatedAt: Date;
}

const ExternalContactSchema = new Schema<IExternalContact>(
  {
    ownerUserId: { type: String, required: true, index: true },
    network: { type: String, required: true },
    externalId: { type: String, required: true },
    displayName: { type: String },
    username: { type: String },
    avatarUrl: { type: String },
    phoneHint: { type: String },
  },
  { timestamps: true }
);

// One contact per (owner, network, external id).
ExternalContactSchema.index(
  { ownerUserId: 1, network: 1, externalId: 1 },
  { unique: true }
);

export const ExternalContact = mongoose.model<IExternalContact>(
  "ExternalContact",
  ExternalContactSchema
);
export default ExternalContact;
