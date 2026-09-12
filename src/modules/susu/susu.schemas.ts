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
import { CYCLE_MONTHS } from '../../lib/account-number.js';
import { CORRECTION_STATUSES } from '../../models/index.js';

export const openAccountBody = z.object({
  customerId: objectId,
  /** Fixed daily amount in pesewas — immutable for the life of the cycle. */
  dailyAmount: positiveMoneyPesewas.min(SUSU_MIN_DAILY_AMOUNT, 'Minimum daily amount is GHS 10'),
  /**
   * The month the cycle is called, appended to the account number as `-SEP`.
   * Any of the twelve is allowed: a cycle opened at the end of one month for
   * the next is the point of the field. Defaults to the current month.
   */
  cycleMonth: z.enum(CYCLE_MONTHS).optional(),
});
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z.enum(['active', 'completed', 'pending-payout', 'closed', 'terminated']).optional(),
    /**
     * Current format (SU26090005-SEP), a number without its cycle month
     * (SU26090005 — what a customer reading off a receipt will quote), or a
     * grandfathered 6-digit number, which now wears a month like any other.
     *
     * Matches the customer's whole susu history, not one book: the number
     * belongs to them. A number quoted from a receipt printed before the
     * numbers were collapsed matches too, through `issuedNumber`.
     */
    accountNumber: z
      .string()
      .regex(
        /^(SU\d{8}|\d{6})(-(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC))?$/,
        'Expected an account number like SU26090005-SEP',
      )
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

export const payoutIdParams = z.object({ id: objectId, payoutId: objectId });
export type PayoutIdParams = z.infer<typeof payoutIdParams>;

export const updateDepositBody = z.object({
  /** Corrected cash amount, pesewas — must be a multiple of the daily amount. */
  amount: positiveMoneyPesewas,
});
export type UpdateDepositBody = z.infer<typeof updateDepositBody>;

/**
 * A teller asking the office to correct a deposit. The same amount rule as a
 * direct correction, plus a reason: the office decides on that line, so it
 * is not optional the way a trash reason is.
 */
export const proposeCorrectionBody = z.object({
  amount: positiveMoneyPesewas,
  reason: z.string().min(3).max(300).trim(),
});
export type ProposeCorrectionBody = z.infer<typeof proposeCorrectionBody>;

export const correctionIdParams = z.object({ correctionId: objectId });
export type CorrectionIdParams = z.infer<typeof correctionIdParams>;

export const listCorrectionsQuery = pagination.extend({
  status: z.enum(CORRECTION_STATUSES).optional(),
  accountId: objectId.optional(),
});
export type ListCorrectionsQuery = z.infer<typeof listCorrectionsQuery>;

export const rejectCorrectionBody = z.object({
  /** Why not, in words the teller will read. */
  reason: z.string().min(3).max(300).trim(),
});
export type RejectCorrectionBody = z.infer<typeof rejectCorrectionBody>;

export const listTrashQuery = pagination;
export type ListTrashQuery = z.infer<typeof listTrashQuery>;

/**
 * Partial withdrawal from an OPEN account. No commission is taken here — it is
 * one cycle-day's amount, charged once, at closure. One day's amount stays
 * reserved in the account so that commission remains collectible.
 */
export const partialWithdrawalBody = z.object({
  /** What the customer receives, in pesewas. */
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
});
export type PartialWithdrawalBody = z.infer<typeof partialWithdrawalBody>;

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
