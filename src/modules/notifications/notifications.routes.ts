import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  listNotificationsQuery,
  notificationIdParams,
  pushSubscriptionBody,
  unsubscribeBody,
  type ListNotificationsQuery,
  type NotificationIdParams,
  type PushSubscriptionBody,
  type UnsubscribeBody,
} from './notifications.schemas.js';
import * as service from './notifications.service.js';

export const notificationsRouter = Router();
notificationsRouter.use(requireAuth);

// Every staff member reads their own notifications — including collectors.
notificationsRouter.get('/', validate({ query: listNotificationsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListNotificationsQuery }>(req);
  service
    .listNotifications(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

// Cheap enough for the bell badge to poll.
notificationsRouter.get('/unread-count', (req, res, next) => {
  service
    .unreadCount(getAuth(req))
    .then((result) => res.json(result))
    .catch(next);
});

// What the browser needs before PushManager.subscribe().
notificationsRouter.get('/push/config', (_req, res) => {
  res.json(service.pushConfig());
});

notificationsRouter.post(
  '/push/subscribe',
  validate({ body: pushSubscriptionBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: PushSubscriptionBody }>(req);
    service
      .subscribeToPush(getAuth(req), body)
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);

notificationsRouter.post(
  '/push/unsubscribe',
  validate({ body: unsubscribeBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: UnsubscribeBody }>(req);
    service
      .unsubscribeFromPush(getAuth(req), body.endpoint)
      .then((result) => res.json(result))
      .catch(next);
  },
);

notificationsRouter.post('/read-all', (req, res, next) => {
  service
    .markAllRead(getAuth(req))
    .then((result) => res.json(result))
    .catch(next);
});

notificationsRouter.post(
  '/:id/read',
  validate({ params: notificationIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: NotificationIdParams }>(req);
    service
      .markRead(getAuth(req), params.id)
      .then((notification) => res.json({ notification }))
      .catch(next);
  },
);
