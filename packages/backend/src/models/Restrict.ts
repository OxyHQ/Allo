import mongoose, { Schema, Document } from "mongoose";

export interface IRestrict extends Document {
  userId: string; // Oxy user ID who is restricting
  restrictedId: string; // Oxy user ID who is restricted
  createdAt: Date;
  updatedAt: Date;
}

const RestrictSchema = new Schema<IRestrict>(
  {
    userId: { type: String, required: true, index: true },
    restrictedId: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

// Ensure unique restrict relationship
RestrictSchema.index({ userId: 1, restrictedId: 1 }, { unique: true });

export const Restrict = mongoose.model<IRestrict>("Restrict", RestrictSchema);
export default Restrict;

