import { z } from 'zod';
import {
  channel,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';
import { SUSU_CYCLE_DEPOSITS, SUSU_MIN_DAILY_AMOUNT } from '../../domain/susu.js';

export const openAccountBody = z.object({
  customerId: objectId,
  /** Fixed daily amount in pesewas — immutable for the life of the cycle. */
  dailyAmount: positiveMoneyPesewas.min(SUSU_MIN_DAILY_AMOUNT, 'Minimum daily amount is GHS 5'),
});
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination.extend({
  customerId: objectId.optional(),
  status: z.enum(['active', 'completed', 'closed']).optional(),
  accountNumber: z
    .string()
    .regex(/^\d{6}$/)
    .optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;

export const accountIdParams = z.object({ id: objectId });
export type AccountIdParams = z.infer<typeof accountIdParams>;

export const depositBody = z.object({
  /** 1 = today's deposit; >1 = catch-up covering missed days. */
  daysCovered: z.number().int().min(1).max(SUSU_CYCLE_DEPOSITS).default(1),
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

export const listDepositsQuery = pagination;
export type ListDepositsQuery = z.infer<typeof listDepositsQuery>;

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
