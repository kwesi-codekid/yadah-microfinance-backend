import { Schema, model, type Types } from 'mongoose';

/**
 * One in-app notification for one staff member. Persisted so it survives a
 * refresh and carries unread state — unlike the Socket.io feed, which is a
 * live nudge only. Notifications are never a source of truth about money;
 * the linked entity always is.
 */
export const NOTIFICATION_TYPES = [
  'susu.deposit',
  'susu.withdrawal',
  'susu.payout',
  'savings.deposit',
  'savings.withdrawal',
  'customer.reassigned',
  'reconciliation.declared',
  'reconciliation.variance',
  'loan.overdue',
] as const;
export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export interface Notification {
  _id: Types.ObjectId;
  /** Recipient. One document per recipient — never a shared broadcast row. */
  userId: Types.ObjectId;
  type: NotificationType;
  title: string;
  body: string;
  /** What the UI should open: entity kind + id, plus anything else useful. */
  data?: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const notificationSchema = new Schema<Notification>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    type: { type: String, enum: NOTIFICATION_TYPES, required: true },
    title: { type: String, required: true },
    body: { type: String, required: true },
    data: { type: Schema.Types.Mixed },
    readAt: { type: Date },
  },
  { timestamps: true },
);

// The two queries the bell icon makes: recent-first, and unread count.
notificationSchema.index({ userId: 1, createdAt: -1 });
notificationSchema.index({ userId: 1, readAt: 1 });

export const NotificationModel = model<Notification>(
  'Notification',
  notificationSchema,
  'notifications',
);
