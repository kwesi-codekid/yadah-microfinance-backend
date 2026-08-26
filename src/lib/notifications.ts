import { Types } from 'mongoose';
import webpush, { WebPushError } from 'web-push';
import { env } from '../config/env.js';
import { logger } from './logger.js';
import { emitToUsers } from './realtime.js';
import {
  NotificationModel,
  PushSubscriptionModel,
  UserModel,
  type NotificationType,
} from '../models/index.js';

/**
 * In-app + browser-push notifications.
 *
 * Same discipline as SMS (rule 8): delivery is fire-and-forget and must never
 * fail or roll back the money transaction that triggered it. Call AFTER the
 * transaction commits, never inside one. Nothing here throws.
 */

let pushConfigured = false;

/** Idempotent — safe to call at boot whether or not the keys are present. */
export function initPush(): void {
  if (pushConfigured) return;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    logger.info('web push disabled — VAPID keys not configured');
    return;
  }
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  pushConfigured = true;
}

export function isPushConfigured(): boolean {
  return pushConfigured;
}

/** The key a browser needs to subscribe. Empty when push is not configured. */
export function publicVapidKey(): string {
  return env.VAPID_PUBLIC_KEY;
}

export interface NotifyOptions {
  /** Recipients. Duplicates are collapsed; an empty list is a no-op. */
  userIds: (Types.ObjectId | string)[];
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, unknown>;
}

/**
 * Store one notification per recipient, nudge any live socket, and push to
 * every registered browser. Failures are logged and swallowed.
 */
export async function notify(opts: NotifyOptions): Promise<void> {
  try {
    const ids = [
      ...new Map(
        opts.userIds
          .map((id) => (typeof id === 'string' ? new Types.ObjectId(id) : id))
          .map((id) => [id.toHexString(), id]),
      ).values(),
    ];
    if (ids.length === 0) return;

    const docs = await NotificationModel.insertMany(
      ids.map((userId) => ({
        userId,
        type: opts.type,
        title: opts.title,
        body: opts.body,
        ...(opts.data !== undefined ? { data: opts.data } : {}),
      })),
    );

    for (const doc of docs) {
      emitToUsers([doc.userId.toHexString()], 'notification', {
        id: doc._id.toHexString(),
        type: doc.type,
        title: doc.title,
        body: doc.body,
        data: doc.data ?? null,
        createdAt: doc.createdAt,
      });
    }

    await sendPush(ids, opts);
  } catch (err) {
    logger.warn({ err, type: opts.type }, 'notification delivery failed');
  }
}

async function sendPush(userIds: Types.ObjectId[], opts: NotifyOptions): Promise<void> {
  if (!pushConfigured) return;
  const subscriptions = await PushSubscriptionModel.find({ userId: { $in: userIds } });
  if (subscriptions.length === 0) return;

  const payload = JSON.stringify({
    title: opts.title,
    body: opts.body,
    type: opts.type,
    data: opts.data ?? null,
  });

  const dead: Types.ObjectId[] = [];
  await Promise.all(
    subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
          payload,
        );
        sub.lastUsedAt = new Date();
        await sub.save();
      } catch (err) {
        // 404/410 mean the browser threw the subscription away — stop pushing
        // to it rather than retrying forever.
        if (err instanceof WebPushError && (err.statusCode === 404 || err.statusCode === 410)) {
          dead.push(sub._id);
          return;
        }
        logger.warn({ err, subscriptionId: sub._id.toHexString() }, 'web push send failed');
      }
    }),
  );

  if (dead.length > 0) {
    await PushSubscriptionModel.deleteMany({ _id: { $in: dead } });
    logger.info({ removed: dead.length }, 'pruned expired push subscriptions');
  }
}

/**
 * Fire-and-forget wrapper for call sites that must not await delivery — a
 * deposit response should not wait on a push service.
 */
export function notifyInBackground(opts: NotifyOptions): void {
  void notify(opts);
}

/** Active admins and managers — the default audience for office alerts. */
export async function officeUserIds(): Promise<Types.ObjectId[]> {
  const users = await UserModel.find(
    { role: { $in: ['admin', 'manager'] }, status: 'active' },
    { _id: 1 },
  ).lean();
  return users.map((u) => u._id);
}

/** Notifies the office without making the caller wait on delivery. */
export function notifyOffice(
  opts: Omit<NotifyOptions, 'userIds'> & { alsoNotify?: (Types.ObjectId | string)[] },
): void {
  void (async () => {
    try {
      const { alsoNotify, ...rest } = opts;
      await notify({ ...rest, userIds: [...(await officeUserIds()), ...(alsoNotify ?? [])] });
    } catch (err) {
      logger.warn({ err, type: opts.type }, 'office notification failed');
    }
  })();
}
