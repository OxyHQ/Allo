import mongoose, { Schema, Document } from "mongoose";

export type CallType = "audio" | "video";
export type CallStatus =
  | "initiated"
  | "ringing"
  | "connected"
  | "completed"
  | "missed"
  | "declined"
  | "failed"
  | "canceled";

export interface ICall extends Document {
  callerId: string;
  calleeId: string;
  conversationId?: string;
  type: CallType;
  status: CallStatus;
  startedAt: Date;
  connectedAt?: Date;
  endedAt?: Date;
  durationSec?: number;
  endedBy?: string;
  createdAt: Date;
  updatedAt: Date;
}

const CallSchema = new Schema<ICall>(
  {
    callerId: { type: String, required: true, index: true },
    calleeId: { type: String, required: true, index: true },
    conversationId: { type: String, index: true },
    type: {
      type: String,
      enum: ["audio", "video"],
      required: true,
    },
    status: {
      type: String,
      enum: [
        "initiated",
        "ringing",
        "connected",
        "completed",
        "missed",
        "declined",
        "failed",
        "canceled",
      ],
      required: true,
      default: "initiated",
      index: true,
    },
    startedAt: { type: Date, required: true, default: () => new Date() },
    connectedAt: { type: Date },
    endedAt: { type: Date },
    durationSec: { type: Number, min: 0 },
    endedBy: { type: String },
  },
  { timestamps: true }
);

// Compound indexes for efficient history queries by participant
CallSchema.index({ callerId: 1, startedAt: -1 });
CallSchema.index({ calleeId: 1, startedAt: -1 });

export const Call = mongoose.model<ICall>("Call", CallSchema);
export default Call;
