import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import { verifyAccessToken, type AccessTokenPayload } from '../modules/auth/auth.service.js';

export interface AuthedRequest extends Request {
  auth: AccessTokenPayload;
}

/** Verifies the Bearer access token and attaches its payload as req.auth. */
export const requireAuth: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new AppError('UNAUTHORIZED', 'Missing Bearer token', 401));
    return;
  }
  const payload = verifyAccessToken(header.slice('Bearer '.length));
  (req as AuthedRequest).auth = payload;
  next();
};

/** Typed accessor for the payload set by requireAuth. */
export function getAuth(req: Request): AccessTokenPayload {
  const auth = (req as Partial<AuthedRequest>).auth;
  if (!auth) {
    throw new AppError('INTERNAL_ERROR', 'getAuth called on a route without requireAuth', 500);
  }
  return auth;
}
