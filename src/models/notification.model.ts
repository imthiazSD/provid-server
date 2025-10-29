import mongoose, { Schema, Document } from 'mongoose';

export interface INotification extends Document {
  userId: string;
  type: string;
  title: string;
  message: string;
  data: Record<string, any>;
  read: boolean;
  timestamp: Date;
}

const NotificationSchema = new Schema<INotification>({
  userId: { type: String, required: true, index: true },
  type: { type: String, required: true },
  title: { type: String, required: true },
  message: { type: String, required: true },
  data: { type: Schema.Types.Mixed, default: {} },
  read: { type: Boolean, default: false },
  timestamp: { type: Date, default: Date.now },
});

export const Notification = mongoose.model<INotification>('Notification', NotificationSchema);
