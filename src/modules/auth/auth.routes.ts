import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  loginBody,
  otpRequestBody,
  otpVerifyBody,
  refreshBody,
  type LoginBody,
  type OtpRequestBody,
  type OtpVerifyBody,
  type RefreshBody,
} from './auth.schemas.js';
import * as authService from './auth.service.js';

export const authRouter = Router();

authRouter.post('/login', validate({ body: loginBody }), (req, res, next) => {
  const { body } = getValidated<{ body: LoginBody }>(req);
  authService
    .login(body.username, body.password)
    .then((result) => res.json(result))
    .catch(next);
});

authRouter.post('/otp/request', validate({ body: otpRequestBody }), (req, res, next) => {
  const { body } = getValidated<{ body: OtpRequestBody }>(req);
  authService
    .requestOtp(body.phone)
    .then(() => res.json({ message: 'If the phone number is registered, a code has been sent' }))
    .catch(next);
});

authRouter.post('/otp/verify', validate({ body: otpVerifyBody }), (req, res, next) => {
  const { body } = getValidated<{ body: OtpVerifyBody }>(req);
  authService
    .verifyOtp(body.phone, body.code)
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
