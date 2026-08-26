import { Schema, model, type Types } from 'mongoose';

/**
 * One browser's Web Push subscription. A user may have several — office
 * desktop, phone, home laptop — so the endpoint, not the user, is the unique
 * key. Dead endpoints are deleted when the push service reports 404/410.
 */
export interface PushSubscription {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  /** Push service URL issued by the browser; unique across all users. */
  endpoint: string;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const pushSubscriptionSchema = new Schema<PushSubscription>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    endpoint: { type: String, required: true, unique: true },
    keys: {
      p256dh: { type: String, required: true },
      auth: { type: String, required: true },
    },
    userAgent: { type: String },
    lastUsedAt: { type: Date },
  },
  { timestamps: true },
);

pushSubscriptionSchema.index({ userId: 1 });

export const PushSubscriptionModel = model<PushSubscription>(
  'PushSubscription',
  pushSubscriptionSchema,
  'push-subscriptions',
);
