import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { NOTIFICATION_TYPES } from '../../models/notification.model.js';
import {
  listNotificationsQuery,
  pushSubscriptionBody,
  unsubscribeBody,
} from './notifications.schemas.js';

const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Notification id') });

const notification = z
  .object({
    id: z.string(),
    type: z.enum(NOTIFICATION_TYPES),
    title: z.string(),
    body: z.string(),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('What to open: entity kind + id, plus anything else useful'),
    readAt: z.iso.datetime().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'Notification' });

export const notificationPaths: ZodOpenApiPathsObject = {
  '/notifications': {
    get: {
      tags: ['Notifications'],
      summary: 'List my notifications',
      description:
        'Strictly per-user — there is no cross-user read, and collectors are included. ' +
        '`unread` is always the full unread count, not just what is on this page. ' +
        'Notifications are never a source of truth about money; the linked entity is.',
      security,
      requestParams: { query: listNotificationsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated notifications',
          z.object({
            items: z.array(notification),
            page: z.number().int(),
            limit: z.number().int(),
            total: z.number().int(),
            unread: z.number().int(),
          }),
        ),
      },
    },
  },
  '/notifications/unread-count': {
    get: {
      tags: ['Notifications'],
      summary: 'Unread badge count',
      description: 'Cheap enough for the bell icon to poll.',
      security,
      responses: { '200': jsonResponse('Count', z.object({ unread: z.number().int() })) },
    },
  },
  '/notifications/push/config': {
    get: {
      tags: ['Notifications'],
      summary: 'VAPID public key for the browser',
      description:
        'What the browser needs before calling PushManager.subscribe(). `enabled` is false ' +
        'when the server has no VAPID keys configured — in-app notifications still work, ' +
        'browser push is simply skipped.',
      security,
      responses: {
        '200': jsonResponse(
          'Push configuration',
          z.object({ enabled: z.boolean(), publicKey: z.string() }),
        ),
      },
    },
  },
  '/notifications/push/subscribe': {
    post: {
      tags: ['Notifications'],
      summary: 'Register this browser for push',
      description:
        'Send the PushSubscription object verbatim. Keyed on endpoint, so re-subscribing ' +
        'the same browser updates it rather than piling up duplicates. A user may have ' +
        'several devices. Dead endpoints are pruned automatically when the push service ' +
        'reports the subscription is gone.',
      security,
      requestBody: jsonBody(pushSubscriptionBody),
      responses: { '201': jsonResponse('Subscribed', z.object({ subscribed: z.literal(true) })) },
    },
  },
  '/notifications/push/unsubscribe': {
    post: {
      tags: ['Notifications'],
      summary: 'Stop pushing to this browser',
      description: 'Idempotent — removing an endpoint that is already gone is a success.',
      security,
      requestBody: jsonBody(unsubscribeBody),
      responses: { '200': jsonResponse('Removed', z.object({ removed: z.number().int() })) },
    },
  },
  '/notifications/read-all': {
    post: {
      tags: ['Notifications'],
      summary: 'Mark everything read',
      security,
      responses: {
        '200': jsonResponse('How many changed', z.object({ updated: z.number().int() })),
      },
    },
  },
  '/notifications/{id}/read': {
    post: {
      tags: ['Notifications'],
      summary: 'Mark one notification read',
      description: 'Idempotent — re-reading keeps the original timestamp.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Updated', z.object({ notification })),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
};
