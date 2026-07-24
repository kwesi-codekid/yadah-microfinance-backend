import type { RequestHandler } from 'express';
import { Types, type QueryFilter } from 'mongoose';
import { AppError } from '../lib/errors.js';
import type { Customer } from '../models/index.js';
import type { Role } from '../models/shared.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { getAuth } from './auth.js';

/** Route gate: only the listed roles pass. Use after requireAuth. */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    const auth = getAuth(req);
    if (!roles.includes(auth.role)) {
      next(new AppError('FORBIDDEN', 'You do not have permission to perform this action', 403));
      return;
    }
    next();
  };
}

/** Office staff only (withdrawals, loan admin, user management is admin-only). */
export const requireOffice = requireRole('admin', 'manager');

/**
 * Collectors may only see/act on their own assigned customers (rule 6).
 * Services must merge this into every customer-related query — enforcement
 * lives in the data access, not in route middleware, because ownership is
 * only knowable from the data.
 */
export function customerScopeFilter(auth: AccessTokenPayload): QueryFilter<Customer> {
  if (auth.role === 'collector') {
    return { assignedCollectorId: new Types.ObjectId(auth.sub) };
  }
  return {};
}

/** Single-document guard for when the customer is already loaded. */
export function assertCanActOnCustomer(
  auth: AccessTokenPayload,
  customer: Pick<Customer, 'assignedCollectorId'>,
): void {
  if (auth.role !== 'collector') return;
  if (customer.assignedCollectorId?.toHexString() !== auth.sub) {
    throw new AppError('FORBIDDEN', 'This customer is not assigned to you', 403);
  }
}
