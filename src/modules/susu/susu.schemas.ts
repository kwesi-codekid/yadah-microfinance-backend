import { z } from 'zod';
import {
  channel,
  dateRangeFields,
  exportFormat,
  fromToIssue,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';
import { SUSU_MIN_DAILY_AMOUNT } from '../../domain/susu.js';

export const openAccountBody = z.object({
  customerId: objectId,
  /** Fixed daily amount in pesewas — immutable for the life of the cycle. */
  dailyAmount: positiveMoneyPesewas.min(SUSU_MIN_DAILY_AMOUNT, 'Minimum daily amount is GHS 5'),
});
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z.enum(['active', 'completed', 'pending-payout', 'closed', 'terminated']).optional(),
    accountNumber: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    /** Fuzzy: customer name (typo-tolerant), phone, or account number prefix. */
    search: z.string().min(1).max(100).optional(),
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;

export const accountIdParams = z.object({ id: objectId });
export type AccountIdParams = z.infer<typeof accountIdParams>;

export const depositBody = z.object({
  /**
   * Cash received in pesewas — must be a multiple of the account's daily
   * amount. One multiple = today's deposit; more covers missed days.
   */
  amount: positiveMoneyPesewas,
  idempotencyKey,
  channel,
});
export type DepositBody = z.infer<typeof depositBody>;

export const collectAllBody = z.object({
  customerId: objectId,
  /** Total cash handed over — must equal one day's deposit across all active accounts. */
  amount: positiveMoneyPesewas,
  idempotencyKey,
  channel,
});
export type CollectAllBody = z.infer<typeof collectAllBody>;

export const listDepositsQuery = pagination
  .extend({ ...dateRangeFields, format: exportFormat })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListDepositsQuery = z.infer<typeof listDepositsQuery>;

export const depositIdParams = z.object({ id: objectId, depositId: objectId });
export type DepositIdParams = z.infer<typeof depositIdParams>;

export const updateDepositBody = z.object({
  /** Corrected cash amount, pesewas — must be a multiple of the daily amount. */
  amount: positiveMoneyPesewas,
});
export type UpdateDepositBody = z.infer<typeof updateDepositBody>;

export const listTrashQuery = pagination;
export type ListTrashQuery = z.infer<typeof listTrashQuery>;

export const payoutBody = z.object({
  /** Omit to pay out the full remaining balance. */
  amount: positiveMoneyPesewas.min(1).optional(),
  idempotencyKey,
});
export type PayoutBody = z.infer<typeof payoutBody>;

export const summaryQuery = z.object({
  /** Accra calendar day, defaults to today. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Office roles may inspect any collector; collectors are pinned to themselves. */
  collectorId: objectId.optional(),
});
export type SummaryQuery = z.infer<typeof summaryQuery>;
