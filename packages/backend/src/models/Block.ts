import mongoose, { Schema, Document } from "mongoose";

export interface IBlock extends Document {
  userId: string; // Oxy user ID who is blocking
  blockedId: string; // Oxy user ID who is blocked
  createdAt: Date;
  updatedAt: Date;
}

const BlockSchema = new Schema<IBlock>(
  {
    userId: { type: String, required: true, index: true },
    blockedId: { type: String, required: true, index: true },
  },
  { timestamps: true }
);

// Ensure unique block relationship
BlockSchema.index({ userId: 1, blockedId: 1 }, { unique: true });

export const Block = mongoose.model<IBlock>("Block", BlockSchema);
export default Block;

