import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { loginBody, refreshBody, type LoginBody, type RefreshBody } from './auth.schemas.js';
import * as authService from './auth.service.js';

export const authRouter = Router();

authRouter.post('/login', validate({ body: loginBody }), (req, res, next) => {
  const { body } = getValidated<{ body: LoginBody }>(req);
  authService
    .login(body.phone, body.password)
    .then((result) => res.json(result))
    .catch(next);
});

authRouter.post('/refresh', validate({ body: refreshBody }), (req, res, next) => {
  const { body } = getValidated<{ body: RefreshBody }>(req);
  authService
    .refresh(body.refreshToken)
    .then((tokens) => res.json({ tokens }))
    .catch(next);
});

authRouter.post('/logout', validate({ body: refreshBody }), (req, res, next) => {
  const { body } = getValidated<{ body: RefreshBody }>(req);
  authService
    .logout(body.refreshToken)
    .then(() => res.status(204).end())
    .catch(next);
});

authRouter.get('/me', requireAuth, (req, res, next) => {
  authService
    .getMe(getAuth(req).sub)
    .then((user) => res.json({ user }))
    .catch(next);
});
