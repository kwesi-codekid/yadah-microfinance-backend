import type { RequestHandler } from 'express';
import { AppError } from '../lib/errors.js';
import type { Role } from '../models/shared.js';
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

/**
 * Office staff only (customer creation, account opening/closure, withdrawals).
 * Role is only half the story for collectors: they are additionally scoped to
 * their own assigned customers — see src/lib/customer-scope.ts.
 */
export const requireOffice = requireRole('admin', 'manager');

/** Admin only — reassigning a customer's collector, and user management. */
export const requireAdmin = requireRole('admin');
