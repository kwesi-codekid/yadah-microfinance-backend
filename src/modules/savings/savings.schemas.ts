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
import { MIN_DEPOSIT } from '../../domain/savings.js';
import { SAVINGS_ACCOUNT_TYPES } from '../../models/savings-account.model.js';

export const openAccountBody = z
  .object({
    customerId: objectId,
    /** Label only — student accounts follow identical money rules. */
    accountType: z.enum(SAVINGS_ACCOUNT_TYPES).default('standard'),
    /** Optional opening deposit — subject to the GHS 5 minimum. */
    initialDeposit: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 5').optional(),
    idempotencyKey: idempotencyKey.optional(),
    channel,
  })
  .refine((v) => v.initialDeposit === undefined || v.idempotencyKey !== undefined, {
    message: 'idempotencyKey is required when initialDeposit is provided',
    path: ['idempotencyKey'],
  });
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    accountType: z.enum(SAVINGS_ACCOUNT_TYPES).optional(),
    status: z.enum(['active', 'closed']).optional(),
    /** Current format (SV26080001) or a grandfathered 10-digit number. */
    accountNumber: z
      .string()
      .regex(/^(SV\d{8}|\d{10})$/, 'Expected an account number like SV26080001')
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

export const txnIdParams = z.object({ id: objectId, txnId: objectId });
export type TxnIdParams = z.infer<typeof txnIdParams>;

export const depositBody = z.object({
  amount: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 5'),
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

export const listTxnsQuery = pagination
  .extend({ ...dateRangeFields, format: exportFormat })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListTxnsQuery = z.infer<typeof listTxnsQuery>;

export const listTrashQuery = pagination;
export type ListTrashQuery = z.infer<typeof listTrashQuery>;

export { trashBody, type TrashBody } from '../../schemas/common.js';
