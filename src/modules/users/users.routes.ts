import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireRole } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  createUserBody,
  listUsersQuery,
  resetUserPasswordBody,
  updateUserBody,
  userIdParams,
  type CreateUserBody,
  type ListUsersQuery,
  type ResetUserPasswordBody,
  type UpdateUserBody,
  type UserIdParams,
} from './users.schemas.js';
import * as usersService from './users.service.js';

export const usersRouter = Router();
usersRouter.use(requireAuth);

usersRouter.post(
  '/',
  requireRole('admin'),
  validate({ body: createUserBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: CreateUserBody }>(req);
    usersService
      .createUser(getAuth(req), body, req.id as string)
      .then((user) => res.status(201).json({ user }))
      .catch(next);
  },
);

usersRouter.get(
  '/',
  requireRole('admin', 'manager'),
  validate({ query: listUsersQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: ListUsersQuery }>(req);
    usersService
      .listUsers(query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

usersRouter.get(
  '/:id',
  requireRole('admin', 'manager'),
  validate({ params: userIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: UserIdParams }>(req);
    usersService
      .getUser(params.id)
      .then((user) => res.json({ user }))
      .catch(next);
  },
);

usersRouter.patch(
  '/:id',
  requireRole('admin'),
  validate({ params: userIdParams, body: updateUserBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: UserIdParams; body: UpdateUserBody }>(req);
    usersService
      .updateUser(getAuth(req), params.id, body, req.id as string)
      .then((user) => res.json({ user }))
      .catch(next);
  },
);

usersRouter.post(
  '/:id/reset-password',
  requireRole('admin'),
  validate({ params: userIdParams, body: resetUserPasswordBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: UserIdParams; body: ResetUserPasswordBody }>(
      req,
    );
    usersService
      .resetUserPassword(
        getAuth(req),
        params.id,
        body.newPassword,
        body.mustChangePassword,
        req.id as string,
      )
      .then(() => res.status(204).end())
      .catch(next);
  },
);

usersRouter.post(
  '/:id/disable',
  requireRole('admin'),
  validate({ params: userIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: UserIdParams }>(req);
    usersService
      .setUserStatus(getAuth(req), params.id, 'disabled', req.id as string)
      .then((user) => res.json({ user }))
      .catch(next);
  },
);

usersRouter.post(
  '/:id/enable',
  requireRole('admin'),
  validate({ params: userIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: UserIdParams }>(req);
    usersService
      .setUserStatus(getAuth(req), params.id, 'active', req.id as string)
      .then((user) => res.json({ user }))
      .catch(next);
  },
);
