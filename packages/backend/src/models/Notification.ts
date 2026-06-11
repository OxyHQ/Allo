import mongoose, { Schema, Document } from "mongoose";

export type NotificationEntityType = "message" | "conversation";
export type NotificationKind = "message" | "welcome";

export interface INotification extends Document {
  recipientId: string; // Oxy user ID of the notification recipient
  senderId: string; // Oxy user ID of the actor (or 'system')
  type: NotificationKind;
  entityId: string; // ID of the related entity (message/conversation)
  entityType: NotificationEntityType;
  read: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const NotificationSchema = new Schema<INotification>(
  {
    recipientId: { type: String, required: true, index: true },
    senderId: { type: String, required: true },
    type: { type: String, enum: ["message", "welcome"], required: true },
    entityId: { type: String, required: true },
    entityType: { type: String, enum: ["message", "conversation"], required: true },
    read: { type: Boolean, default: false },
  },
  { timestamps: true }
);

// Compound index for the most common query: a user's unread notifications, newest first
NotificationSchema.index({ recipientId: 1, read: 1, createdAt: -1 });

export const Notification = mongoose.model<INotification>("Notification", NotificationSchema);
export default Notification;
