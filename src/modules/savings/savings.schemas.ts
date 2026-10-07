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
import { FIXED_MAX_MONTHS, FIXED_MIN_MONTHS, MIN_DEPOSIT } from '../../domain/savings.js';
import { SAVINGS_ACCOUNT_TYPES } from '../../models/savings-account.model.js';

export const openAccountBody = z
  .object({
    customerId: objectId,
    /**
     * Standard and student are labels only — identical money rules. A fixed
     * deposit is opened for a child, needs `guardianId` and `termMonths`, and
     * withdraws free once the term is up.
     */
    accountType: z.enum(SAVINGS_ACCOUNT_TYPES).default('standard'),
    /** Fixed deposit: the adult customer — the parent — who is paid out of it. */
    guardianId: objectId.optional(),
    /** Fixed deposit: the term in months — six or more. The maturity day is worked out from it. */
    termMonths: z
      .number()
      .int()
      .min(FIXED_MIN_MONTHS, `A fixed deposit runs at least ${String(FIXED_MIN_MONTHS)} months`)
      .max(FIXED_MAX_MONTHS, 'A fixed deposit runs at most 18 years')
      .optional(),
    /** Optional opening deposit — subject to the GHS 5 minimum. */
    initialDeposit: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 5').optional(),
    idempotencyKey: idempotencyKey.optional(),
    channel,
  })
  .refine((v) => v.initialDeposit === undefined || v.idempotencyKey !== undefined, {
    message: 'idempotencyKey is required when initialDeposit is provided',
    path: ['idempotencyKey'],
  })
  .check((ctx) => {
    const fixed = ctx.value.accountType === 'fixed';
    for (const key of ['guardianId', 'termMonths'] as const) {
      const given = ctx.value[key] !== undefined;
      if (fixed && !given) {
        ctx.issues.push({
          code: 'custom',
          message:
            key === 'guardianId'
              ? 'A fixed deposit needs a guardian'
              : 'A fixed deposit needs a term',
          path: [key],
          input: ctx.value[key],
        });
      }
      if (!fixed && given) {
        ctx.issues.push({
          code: 'custom',
          message: 'Only a fixed deposit has a guardian and a term',
          path: [key],
          input: ctx.value[key],
        });
      }
    }
  });
export type OpenAccountBody = z.infer<typeof openAccountBody>;

export const listAccountsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    /** The fixed deposits this customer stands guardian to. */
    guardianId: objectId.optional(),
    accountType: z.enum(SAVINGS_ACCOUNT_TYPES).optional(),
    status: z.enum(['active', 'closed']).optional(),
    /** Current format (SV26080001) or a grandfathered 10-digit number. */
    accountNumber: z
      .string()
      .regex(/^(SV\d{8,}|\d{10})$/, 'Expected an account number like SV26080001')
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

/**
 * A new number for an account, typed by the office. The stop-gap for numbers
 * issued under the monthly-restart rule (1 Oct 2026) until the sequence
 * script has run everywhere; also the fix for a number quoted wrongly.
 */
export const accountNumberBody = z.object({
  accountNumber: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^(SV\d{8,}|\d{10})$/, 'Expected an account number like SV26100361'),
});
export type AccountNumberBody = z.infer<typeof accountNumberBody>;

/** Renumber this month's accounts into the continuing sequence: false previews, true writes. */
export const renumberBody = z.object({ apply: z.boolean() });
export type RenumberBody = z.infer<typeof renumberBody>;

export const txnIdParams = z.object({ id: objectId, txnId: objectId });
export type TxnIdParams = z.infer<typeof txnIdParams>;

/**
 * The Accra day the money actually changed hands, for history typed in after
 * the fact. Omit it and the transaction is dated now. Refused unless the
 * server has backdating turned on (see lib/backdating.ts), and a backdated
 * transaction is threaded into the account's running balance at the position
 * its date puts it in, not simply appended.
 */
export const occurredOn = isoDay
  .optional()
  .describe(
    'The Accra day the money actually changed hands (YYYY-MM-DD). Omit it and a transaction ' +
      'is dated now, which is what every ordinary one is. Data-population stage only: ' +
      'refused with BACKDATING_DISABLED unless the server has ALLOW_BACKDATED_ENTRY set, ' +
      'and refused for a collector, whose day is the one being reconciled.',
  );

export const depositBody = z.object({
  amount: positiveMoneyPesewas.min(MIN_DEPOSIT, 'Minimum deposit is GHS 5'),
  idempotencyKey,
  channel,
  occurredOn,
});
export type DepositBody = z.infer<typeof depositBody>;

export const withdrawalBody = z.object({
  /** What the customer receives; the flat GHS 10 fee is debited on top. */
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
  occurredOn,
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
