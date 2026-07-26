import { z } from 'zod';
import {
  channel,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';
import { MIN_DEPOSIT } from '../../domain/savings.js';

export const openAccountBody = z
  .object({
    customerId: objectId,
    /** Optional opening deposit — subject to the GHS 10 minimum. */
    initialDeposit: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 10').optional(),
    idempotencyKey: idempotencyKey.optional(),
    channel,
  })
  .refine((v) => v.initialDeposit === undefined || v.idempotencyKey !== undefined, {
    message: 'idempotencyKey is required when initialDeposit is provided',
    path: ['idempotencyKey'],
  });
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination.extend({
  customerId: objectId.optional(),
  status: z.enum(['active', 'closed']).optional(),
  accountNumber: z
    .string()
    .regex(/^\d{10}$/)
    .optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;

export const accountIdParams = z.object({ id: objectId });
export type AccountIdParams = z.infer<typeof accountIdParams>;

export const depositBody = z.object({
  amount: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 10'),
  idempotencyKey,
  channel,
});
export type DepositBody = z.infer<typeof depositBody>;

export const withdrawalBody = z.object({
  /** What the customer receives; the flat GHS 10 fee is debited on top. */
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
});
export type WithdrawalBody = z.infer<typeof withdrawalBody>;

export const listTxnsQuery = pagination;
export type ListTxnsQuery = z.infer<typeof listTxnsQuery>;
