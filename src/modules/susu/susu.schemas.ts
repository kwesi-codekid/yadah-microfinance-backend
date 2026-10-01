import { z } from 'zod';
import {
  channel,
  dateRangeFields,
  exportFormat,
  fromToIssue,
  idempotencyKey,
  isoDay,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';
import { SUSU_MIN_DAILY_AMOUNT } from '../../domain/susu-plans.js';

const dailyAmount = positiveMoneyPesewas.min(
  SUSU_MIN_DAILY_AMOUNT,
  'Minimum daily amount is GHS 10',
);

/**
 * Opens the customer's one susu account with its first plan. A customer whose
 * account was closed gets it reopened — same number, same history.
 */
export const openAccountBody = z.object({
  customerId: objectId,
  /** The first plan's daily amount in pesewas. */
  dailyAmount,
});
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z.enum(['active', 'closed']).optional(),
    /** SU26090005, or a grandfathered 6-digit number. */
    accountNumber: z
      .string()
      .regex(/^(SU\d{8,}|\d{6})$/, 'Expected an account number like SU26090005')
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

/**
 * The Accra day the money actually changed hands, for history typed in after
 * the fact. Omit it and the transaction is dated now, which is what every
 * ordinary collection does. Refused unless the server has backdating turned
 * on for the data-population stage (see lib/backdating.ts).
 */
export const occurredOn = isoDay
  .optional()
  .describe(
    'The Accra day the money actually changed hands (YYYY-MM-DD). Omit it and a collection ' +
      'is dated now, which is what every ordinary one is. Data-population stage only: ' +
      'refused with BACKDATING_DISABLED unless the server has ALLOW_BACKDATED_ENTRY set, ' +
      'and refused for a collector, whose day is the one being reconciled.',
  );

export const accountIdParams = z.object({ id: objectId });
export type AccountIdParams = z.infer<typeof accountIdParams>;

export const planIdParams = z.object({ id: objectId, planId: objectId });
export type PlanIdParams = z.infer<typeof planIdParams>;

export const addPlanBody = z.object({ dailyAmount });
export type AddPlanBody = z.infer<typeof addPlanBody>;

/** Only between cycles — refused with PLAN_MID_CYCLE otherwise. */
export const changePlanBody = z.object({ dailyAmount });
export type ChangePlanBody = z.infer<typeof changePlanBody>;

/**
 * How a deposit is credited to the plans: whole payments per plan. Omit it
 * for one payment on every active plan — what a collector's daily round is.
 */
export const depositSplit = z
  .array(
    z.object({
      planId: objectId,
      payments: z.number().int().min(0).max(62),
    }),
  )
  .min(1)
  .max(20);
export type DepositSplit = z.infer<typeof depositSplit>;

export const depositBody = z.object({
  /** Cash received in pesewas. Whatever the split does not use stays in the balance. */
  amount: positiveMoneyPesewas,
  split: depositSplit.optional(),
  idempotencyKey,
  channel,
  occurredOn,
});
export type DepositBody = z.infer<typeof depositBody>;

export const listDepositsQuery = pagination
  .extend({ ...dateRangeFields, format: exportFormat })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListDepositsQuery = z.infer<typeof listDepositsQuery>;

export const listCyclesQuery = pagination.extend({ planId: objectId.optional() });

/** Money out, newest first; `planId` keeps only the payouts with a share on that plan. */
export const listPayoutsQuery = pagination.extend({ planId: objectId.optional() });
export type ListPayoutsQuery = z.infer<typeof listPayoutsQuery>;

/** The susu data update: false reports what would change, true writes it. */
export const migrateBody = z.object({ apply: z.boolean() });
export type MigrateBody = z.infer<typeof migrateBody>;
export type ListCyclesQuery = z.infer<typeof listCyclesQuery>;

export const depositIdParams = z.object({ id: objectId, depositId: objectId });
export type DepositIdParams = z.infer<typeof depositIdParams>;

export const payoutIdParams = z.object({ id: objectId, payoutId: objectId });
export type PayoutIdParams = z.infer<typeof payoutIdParams>;

/**
 * A correction re-credits the deposit from scratch at the new amount. The
 * split may be omitted when the deposit paid one plan; a deposit that was
 * split across plans needs the new split spelled out.
 */
export const updateDepositBody = z.object({
  amount: positiveMoneyPesewas,
  split: depositSplit.optional(),
});
export type UpdateDepositBody = z.infer<typeof updateDepositBody>;

export const listTrashQuery = pagination;
export type ListTrashQuery = z.infer<typeof listTrashQuery>;

/**
 * Money out of an open account. No commission is taken here; one payment per
 * plan with a cycle in progress stays locked so it is collectible later.
 */
export const withdrawalBody = z.object({
  /** What the customer receives, in pesewas. */
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
});
export type WithdrawalBody = z.infer<typeof withdrawalBody>;

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
