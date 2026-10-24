import { z } from 'zod';
import {
  channel,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';
import { SUSU_LOAN_TXN_TYPES } from '../../models/susu-loan-txn.model.js';

/** Any amount, any day (client decision, 23 Oct 2026) — no minimum. */
const amount = positiveMoneyPesewas.min(1);

export const openAccountBody = z
  .object({
    customerId: objectId,
    initialDeposit: amount.optional(),
    idempotencyKey: idempotencyKey.optional(),
  })
  .refine((v) => v.initialDeposit === undefined || v.idempotencyKey !== undefined, {
    message: 'idempotencyKey is required when initialDeposit is provided',
    path: ['idempotencyKey'],
  });
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination.extend({
  customerId: objectId.optional(),
  status: z.enum(['active', 'closed']).optional(),
  /** Fuzzy: customer name (typo-tolerant), phone, or account number prefix. */
  search: z.string().min(1).max(100).optional(),
});
export type ListAccountsQuery = z.infer<typeof listAccountsQuery>;

export const accountIdParams = z.object({ id: objectId });
export type AccountIdParams = z.infer<typeof accountIdParams>;

export const txnIdParams = z.object({ id: objectId, txnId: objectId });
export type TxnIdParams = z.infer<typeof txnIdParams>;

export const listTxnsQuery = pagination.extend({
  type: z.enum(SUSU_LOAN_TXN_TYPES).optional(),
});
export type ListTxnsQuery = z.infer<typeof listTxnsQuery>;

export const depositBody = z.object({ amount, idempotencyKey, channel });
export type DepositBody = z.infer<typeof depositBody>;
