import type { Request, RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import {
  verifyCustomerToken,
  type CustomerTokenPayload,
} from '../modules/portal/portal-auth.service.js';

export interface PortalRequest extends Request {
  portalAuth: CustomerTokenPayload;
}

/**
 * Verifies a customer portal Bearer token and attaches it as req.portalAuth.
 *
 * Kept entirely separate from requireAuth: the two accept tokens signed with
 * different keys, and a portal payload has no `role`, so it can never be fed
 * to the staff RBAC helpers by accident.
 */
export const requireCustomer: RequestHandler = (req, _res, next) => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    next(new AppError('UNAUTHORIZED', 'Missing Bearer token', 401));
    return;
  }
  (req as PortalRequest).portalAuth = verifyCustomerToken(header.slice('Bearer '.length));
  next();
};

/** Typed accessor for the payload set by requireCustomer. */
export function getPortalAuth(req: Request): CustomerTokenPayload {
  const auth = (req as Partial<PortalRequest>).portalAuth;
  if (!auth) {
    throw new AppError(
      'INTERNAL_ERROR',
      'getPortalAuth called on a route without requireCustomer',
      500,
    );
  }
  return auth;
}

/** The authenticated customer's id, as an ObjectId-ready hex string. */
export function portalCustomerId(req: Request): string {
  return getPortalAuth(req).sub;
}
