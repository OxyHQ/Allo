import mongoose, { Schema, Document } from "mongoose";

export interface IUserBehavior extends Document {
  oxyUserId: string; // Oxy user ID
  preferences: Record<string, any>; // User preferences and behavior data
  createdAt: Date;
  updatedAt: Date;
}

const UserBehaviorSchema = new Schema<IUserBehavior>(
  {
    oxyUserId: { type: String, required: true, unique: true, index: true },
    preferences: { type: Schema.Types.Mixed, default: {} },
  },
  { timestamps: true }
);

export const UserBehavior = mongoose.model<IUserBehavior>("UserBehavior", UserBehaviorSchema);
export default UserBehavior;

