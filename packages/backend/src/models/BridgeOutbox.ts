import mongoose, { Schema, Document } from "mongoose";
import type { BridgeCommand } from "@allo/shared-types";

export type BridgeOutboxStatus = "pending" | "sent" | "failed";

/**
 * Durable outbox for outbound bridge commands (owner -> external network).
 *
 * When an Allo user sends to a bridged conversation we persist the command here
 * BEFORE attempting delivery, so a connector outage doesn't lose the message —
 * a background sweeper retries pending rows with exponential backoff until they
 * succeed or exhaust `BRIDGE_OUTBOX_MAX_ATTEMPTS`.
 *
 * `command` is a serialized `BridgeCommand`. It is stored as Mixed; when
 * mutating it in place call `markModified('command')` (we mostly replace whole
 * docs, so this rarely applies).
 */
export interface IBridgeOutbox extends Document {
  /** Allo `Message._id` this command sends; used to correlate `send_result`. */
  messageId: string;
  command: BridgeCommand;
  attempts: number;
  nextAttemptAt: Date;
  status: BridgeOutboxStatus;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

const BridgeOutboxSchema = new Schema<IBridgeOutbox>(
  {
    messageId: { type: String, required: true, index: true },
    command: { type: Schema.Types.Mixed, required: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: Date.now },
    status: {
      type: String,
      enum: ["pending", "sent", "failed"],
      default: "pending",
    },
    lastError: { type: String },
  },
  { timestamps: true }
);

// The sweeper query: due pending rows, oldest first.
BridgeOutboxSchema.index({ status: 1, nextAttemptAt: 1 });

export const BridgeOutbox = mongoose.model<IBridgeOutbox>(
  "BridgeOutbox",
  BridgeOutboxSchema
);
export default BridgeOutbox;
