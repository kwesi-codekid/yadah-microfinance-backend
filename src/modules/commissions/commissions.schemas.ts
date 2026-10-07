import { z } from 'zod';
import { COMMISSION_SOURCES } from '../../models/index.js';
import {
  dateRangeFields,
  fromToIssue,
  idempotencyKey,
  isoDay,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';

/**
 * The commission account's entries, newest first: one source or all, an
 * Accra-day range, and a search over the customer's name or the account
 * number. Totals cover the whole filter, not the page.
 */
export const listCommissionsQuery = pagination
  .extend({
    ...dateRangeFields,
    source: z.enum(COMMISSION_SOURCES).optional(),
    q: z.string().trim().min(1).max(80).optional(),
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListCommissionsQuery = z.infer<typeof listCommissionsQuery>;

/** Moves out of the commission account, newest first. */
export const listMovesQuery = pagination
  .extend({ ...dateRangeFields, cashAccountId: objectId.optional() })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListMovesQuery = z.infer<typeof listMovesQuery>;

/** Commission into one of the company's cash accounts. */
export const createMoveBody = z.object({
  amount: positiveMoneyPesewas.min(1),
  cashAccountId: objectId,
  /** Accra day the money moved; defaults to today. */
  occurredOn: isoDay.optional(),
  note: z.string().trim().max(300).optional(),
  idempotencyKey,
});
export type CreateMoveBody = z.infer<typeof createMoveBody>;

export const moveIdParams = z.object({ id: objectId });
export type MoveIdParams = z.infer<typeof moveIdParams>;
