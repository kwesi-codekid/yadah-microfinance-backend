import { z } from 'zod';
import {
  channel,
  idempotencyKey,
  isoDay,
  objectId,
  onBehalfOfCollector,
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

export const depositBody = z.object({
  amount,
  idempotencyKey,
  channel,
  /** The Accra day it was taken, when not today. */
  occurredOn: isoDay.optional(),
  collectorId: onBehalfOfCollector,
});
export type DepositBody = z.infer<typeof depositBody>;

/** Moves an account opened against the wrong customer. See `editAccount`. */
export const editAccountBody = z.object({
  customerId: objectId,
  reason: z.string().trim().min(3).max(300),
});
export type EditAccountBody = z.infer<typeof editAccountBody>;

/** Any part of a deposit. Only what is sent changes. See `editDeposit`. */
export const editDepositBody = z.object({
  amount: amount.optional(),
  channel: z.enum(['cash', 'momo']).optional(),
  occurredOn: isoDay.optional(),
  /** The collector who took it; null when nobody did — it came in at the office. */
  collectorId: objectId.nullable().optional(),
  reason: z.string().trim().min(3).max(300),
});
export type EditDepositBody = z.infer<typeof editDepositBody>;
