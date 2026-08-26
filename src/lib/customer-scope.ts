import { Types } from 'mongoose';
import { AppError } from './errors.js';
import { CustomerModel } from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * Collector scoping (client decision 2026-08-21, reversing the July rule that
 * any collector could collect from anyone). A collector may only see and act
 * on the customers assigned to them; office roles are unrestricted.
 *
 * This is a hard lock, not a filter for tidiness: a collector reaching for
 * someone else's customer gets 403, never an empty result that looks like the
 * customer does not exist.
 */

/** True when this actor's reads and writes must be narrowed to their own list. */
export function isScoped(actor: AccessTokenPayload): boolean {
  return actor.role === 'collector';
}

/** Mongo filter fragment for queries on the customers collection itself. */
export function customerScopeFilter(actor: AccessTokenPayload): Record<string, unknown> {
  return isScoped(actor) ? { assignedCollectorId: new Types.ObjectId(actor.sub) } : {};
}

/**
 * Ids of the customers this actor may act on, or null when unrestricted.
 * Callers turn a non-null result into a `customerId: { $in: ids }` filter.
 */
export async function scopedCustomerIds(
  actor: AccessTokenPayload,
): Promise<Types.ObjectId[] | null> {
  if (!isScoped(actor)) return null;
  const rows = await CustomerModel.find(
    { assignedCollectorId: new Types.ObjectId(actor.sub), ...NOT_TRASHED },
    { _id: 1 },
  ).lean();
  return rows.map((r) => r._id);
}

/**
 * Adds the collector's customer restriction to a filter keyed by `customerId`.
 * Office actors get the filter back untouched.
 */
export async function withCustomerScope(
  actor: AccessTokenPayload,
  filter: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const ids = await scopedCustomerIds(actor);
  if (ids === null) return filter;
  const existing = filter.customerId;
  if (existing !== undefined) {
    // An explicit customerId filter must still be inside the collector's list.
    const requested = existing as Types.ObjectId;
    const allowed = ids.some((id) => id.equals(requested));
    return allowed ? filter : { ...filter, customerId: { $in: [] } };
  }
  return { ...filter, customerId: { $in: ids } };
}

/** 403 unless the actor may act on this customer. */
export async function assertCanActOnCustomer(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
): Promise<void> {
  if (!isScoped(actor)) return;
  const ok = await CustomerModel.exists({
    _id: customerId,
    assignedCollectorId: new Types.ObjectId(actor.sub),
    ...NOT_TRASHED,
  });
  if (!ok) {
    throw new AppError('CUSTOMER_NOT_ASSIGNED', 'This customer is not assigned to you', 403);
  }
}
