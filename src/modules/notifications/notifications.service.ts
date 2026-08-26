import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { isPushConfigured, publicVapidKey } from '../../lib/notifications.js';
import { NotificationModel, PushSubscriptionModel, type Notification } from '../../models/index.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { ListNotificationsQuery, PushSubscriptionBody } from './notifications.schemas.js';

export interface PublicNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  data?: Record<string, unknown>;
  readAt?: Date;
  createdAt: Date;
}

function toPublic(n: Notification): PublicNotification {
  return {
    id: n._id.toHexString(),
    type: n.type,
    title: n.title,
    body: n.body,
    ...(n.data !== undefined ? { data: n.data } : {}),
    ...(n.readAt !== undefined ? { readAt: n.readAt } : {}),
    createdAt: n.createdAt,
  };
}

export interface NotificationList {
  items: PublicNotification[];
  page: number;
  limit: number;
  total: number;
  /** Always the full unread count, not just what is on this page. */
  unread: number;
}

/** Notifications are strictly per-user — there is no cross-user read. */
export async function listNotifications(
  actor: AccessTokenPayload,
  query: ListNotificationsQuery,
): Promise<NotificationList> {
  const userId = new Types.ObjectId(actor.sub);
  const filter: Record<string, unknown> = { userId };
  if (query.unreadOnly === true) filter.readAt = null;
  if (query.type) filter.type = query.type;

  const [rows, total, unread] = await Promise.all([
    NotificationModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    NotificationModel.countDocuments(filter),
    NotificationModel.countDocuments({ userId, readAt: null }),
  ]);

  return { items: rows.map(toPublic), page: query.page, limit: query.limit, total, unread };
}

export async function unreadCount(actor: AccessTokenPayload): Promise<{ unread: number }> {
  const unread = await NotificationModel.countDocuments({
    userId: new Types.ObjectId(actor.sub),
    readAt: null,
  });
  return { unread };
}

export async function markRead(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicNotification> {
  const notification = await NotificationModel.findOne({
    _id: id,
    userId: new Types.ObjectId(actor.sub),
  });
  if (!notification) throw new AppError('NOT_FOUND', 'Notification not found', 404);
  // Idempotent: re-reading keeps the original timestamp.
  if (!notification.readAt) {
    notification.readAt = new Date();
    await notification.save();
  }
  return toPublic(notification);
}

export async function markAllRead(actor: AccessTokenPayload): Promise<{ updated: number }> {
  const result = await NotificationModel.updateMany(
    { userId: new Types.ObjectId(actor.sub), readAt: null },
    { $set: { readAt: new Date() } },
  );
  return { updated: result.modifiedCount };
}

// ---------------------------------------------------------------- web push

export interface PushConfig {
  enabled: boolean;
  publicKey: string;
}

/** What the browser needs before it can call PushManager.subscribe(). */
export function pushConfig(): PushConfig {
  return { enabled: isPushConfigured(), publicKey: publicVapidKey() };
}

/**
 * Register a browser for push. Keyed on the endpoint, so re-subscribing the
 * same browser updates it rather than piling up duplicates — and a device
 * handed to a different member of staff moves with them.
 */
export async function subscribeToPush(
  actor: AccessTokenPayload,
  body: PushSubscriptionBody,
): Promise<{ subscribed: true }> {
  await PushSubscriptionModel.findOneAndUpdate(
    { endpoint: body.endpoint },
    {
      $set: {
        userId: new Types.ObjectId(actor.sub),
        keys: body.keys,
        ...(body.userAgent !== undefined ? { userAgent: body.userAgent } : {}),
      },
    },
    { upsert: true, new: true },
  );
  return { subscribed: true };
}

/** Idempotent — unsubscribing an endpoint that is already gone is a success. */
export async function unsubscribeFromPush(
  actor: AccessTokenPayload,
  endpoint: string,
): Promise<{ removed: number }> {
  const result = await PushSubscriptionModel.deleteOne({
    endpoint,
    userId: new Types.ObjectId(actor.sub),
  });
  return { removed: result.deletedCount };
}
