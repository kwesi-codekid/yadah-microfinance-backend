import { z } from 'zod';
import { objectId, pagination } from '../../schemas/common.js';
import { NOTIFICATION_TYPES } from '../../models/notification.model.js';

export const listNotificationsQuery = pagination.extend({
  /** Only what the bell badge counts. */
  unreadOnly: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
});
export type ListNotificationsQuery = z.infer<typeof listNotificationsQuery>;

export const notificationIdParams = z.object({ id: objectId });
export type NotificationIdParams = z.infer<typeof notificationIdParams>;

/**
 * The shape the browser's PushManager hands back. Stored verbatim — the keys
 * are what encrypts each push payload for that specific browser.
 */
export const pushSubscriptionBody = z.object({
  endpoint: z.url().max(2000),
  keys: z.object({
    p256dh: z.string().min(1).max(255),
    auth: z.string().min(1).max(255),
  }),
  userAgent: z.string().max(300).optional(),
});
export type PushSubscriptionBody = z.infer<typeof pushSubscriptionBody>;

export const unsubscribeBody = z.object({ endpoint: z.url().max(2000) });
export type UnsubscribeBody = z.infer<typeof unsubscribeBody>;
