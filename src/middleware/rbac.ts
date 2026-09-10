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
 * Two gates, because two different questions get asked of a role.
 *
 * `requireCounter` asks "may you serve whoever is standing here?" — taking
 * money in, paying it out, opening an account, registering the person. Every
 * role but the collector passes, the collector being scoped to their own round
 * instead (see src/lib/customer-scope.ts).
 *
 * `requireOffice` asks "may you decide?" — approving a loan, signing a hire
 * purchase, moving a customer between products, touching the company's own
 * books, or taking anything out of the listings. A teller does not.
 *
 * Anything not explicitly opened to the counter stays office by default, so a
 * route added later is closed until somebody says otherwise.
 */
export const requireCounter = requireRole('admin', 'manager', 'teller');

/**
 * Office staff only. Role is only half the story for collectors: they are
 * additionally scoped to their own assigned customers.
 */
export const requireOffice = requireRole('admin', 'manager');

/** Admin only — reassigning a customer's collector, and user management. */
export const requireAdmin = requireRole('admin');
