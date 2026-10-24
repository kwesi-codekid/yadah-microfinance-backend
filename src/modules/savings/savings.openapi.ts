import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { collectedByShape, errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  correctionPathsFor,
  proposeCorrectionPathFor,
} from '../corrections/corrections.openapi.js';
import {
  depositBody,
  accountNumberBody,
  renumberBody,
  listAccountsQuery,
  listTrashQuery,
  listTxnsQuery,
  openAccountBody,
  trashBody,
  withdrawalBody,
} from './savings.schemas.js';

const savingsAccount = z
  .object({
    id: z.string(),
    accountNumber: z.string().describe('10-digit randomized, unique'),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses, for display'),
    accountType: z
      .enum(['standard', 'student', 'fixed', 'loan'])
      .describe(
        'Standard and student are labels only — money rules are identical. Student ' +
          "accounts: the customer record is the minor; the guardian's ID goes in the " +
          "customer identification fields. Fixed: a child's account with a guardian and a " +
          'maturity date; normal charges before maturity, free withdrawals from it. Loan: the ' +
          'loan savings account, one per customer — deposits only; its money leaves only to ' +
          'repay the loan (POST /loans/{id}/repayments/loan-savings and the automatic ' +
          'deduction). Withdrawal, transfer out and closure with money in it are refused ' +
          'with LOAN_SAVINGS_LOCKED.',
      ),
    maturesOn: z.string().optional().describe('Fixed deposit: YYYY-MM-DD withdrawals turn free'),
    termMonths: z.number().int().optional().describe('Fixed deposit: the term chosen at opening'),
    matured: z.boolean().describe('Fixed deposit past its maturity day — always false otherwise'),
    guardianId: z.string().optional().describe('Fixed deposit: the adult customer paid out of it'),
    guardianName: z.string().optional(),
    balance: z.number().int().describe('Pesewas'),
    availableToWithdraw: z
      .number()
      .int()
      .describe(
        'balance − GHS 10 min balance − GHS 10 fee, never negative; the whole balance on a ' +
          'matured fixed deposit',
      ),
    status: z.enum(['active', 'closed']),
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'SavingsAccount' });

const savingsTxn = z
  .object({
    id: z.string(),
    accountId: z.string(),
    customerId: z.string(),
    type: z.enum(['deposit', 'withdrawal', 'closure']),
    amount: z.number().int().describe('For withdrawals/closure: what the customer receives'),
    fee: z.number().int().optional().describe('GHS 10 flat on withdrawals and closure'),
    balanceAfter: z.number().int(),
    channel: z
      .enum(['cash', 'paystack', 'momo', 'transfer'])
      .describe("'transfer' = created by an internal transfer"),
    accraDay: z.string().describe('Accra calendar day, YYYY-MM-DD'),
    collectedBy: collectedByShape
      .optional()
      .describe('Someone the account holder sent to collect; absent when they came themselves'),
    recordedById: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SavingsTxn' });

const trashedSavingsAccount = savingsAccount.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const trashedSavingsTxn = savingsTxn.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const txnResult = z.object({ txn: savingsTxn, account: savingsAccount, replayed: z.boolean() });
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Savings account id') });
const txnIdParam = z.object({
  id: z.string().describe('Savings account id'),
  txnId: z.string().describe('Transaction id'),
});

export const savingsPaths: ZodOpenApiPathsObject = {
  '/savings/accounts': {
    post: {
      tags: ['Savings'],
      summary: 'Open a savings account (office only)',
      description: 'Optional initialDeposit (min GHS 5) is recorded atomically with the opening.',
      security,
      requestBody: jsonBody(openAccountBody),
      responses: {
        '201': jsonResponse(
          'Opened',
          z.object({ account: savingsAccount, initialTxn: savingsTxn.optional() }),
        ),
        '404': errorResponse('NOT_FOUND — customer'),
        '422': errorResponse('CUSTOMER_INACTIVE'),
      },
    },
    get: {
      tags: ['Savings'],
      summary: 'List accounts',
      description:
        'All roles see all accounts. `search` is fuzzy: typo-tolerant customer ' +
        'name, phone, or account-number prefix. Pass format=csv or format=xlsx ' +
        'to download a spreadsheet (pagination ignored, capped at 10,000 rows).',
      security,
      requestParams: { query: listAccountsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated accounts',
          z.object({
            items: z.array(savingsAccount),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/savings/accounts/trash': {
    get: {
      tags: ['Savings'],
      summary: 'List trashed savings accounts (office only)',
      description: 'Most recently trashed first.',
      security,
      requestParams: { query: listTrashQuery },
      responses: {
        '200': jsonResponse(
          'Paginated trashed accounts',
          z.object({
            items: z.array(trashedSavingsAccount),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/savings/accounts/{id}': {
    get: {
      tags: ['Savings'],
      summary: 'Account detail (includes availableToWithdraw)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The account', z.object({ account: savingsAccount })),
        '403': errorResponse('FORBIDDEN'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
    delete: {
      tags: ['Savings'],
      summary: 'Delete an account, reversing its money (office only)',
      description:
        'Any account, whatever it holds. The account and all its live transactions go ' +
        'to the trash together, so every deposit and withdrawal leaves the books and the ' +
        'withdrawal fees come back out of the commission account; the standing balance is ' +
        'the customer’s cash for the office to hand back. A restore brings the account and ' +
        'those same transactions back. Optional reason (2-300 chars) is stored.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Trashed', z.object({ account: trashedSavingsAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND — missing or already trashed'),
        '409': errorResponse('CONFLICT — the account moved meanwhile; retry'),
      },
    },
  },
  '/savings/accounts/{id}/restore': {
    post: {
      tags: ['Savings'],
      summary: 'Restore an account from the trash (office only)',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ account: savingsAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED — account is not in the trash'),
      },
    },
  },
  '/savings/accounts/{id}/transactions': {
    get: {
      tags: ['Savings'],
      summary: 'Transaction history / statement',
      description:
        'Pass format=csv or format=xlsx to download a spreadsheet ' +
        '(pagination ignored, capped at 10,000 rows).',
      security,
      requestParams: { path: idParam, query: listTxnsQuery },
      responses: {
        '200': jsonResponse(
          'Transactions, newest first',
          z.object({
            items: z.array(savingsTxn),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/savings/accounts/{id}/transactions/trash': {
    get: {
      tags: ['Savings'],
      summary: 'List trashed transactions of an account (office only)',
      security,
      requestParams: { path: idParam, query: listTrashQuery },
      responses: {
        '200': jsonResponse(
          'Trashed transactions, most recently trashed first',
          z.object({
            items: z.array(trashedSavingsTxn),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/savings/accounts/{id}/transactions/{txnId}': {
    ...correctionPathsFor(
      'Savings',
      'a deposit or withdrawal',
      'Only the newest live transaction of an active account can change: every later ' +
        'running balance is built on it (deleting a transaction, which rewrites those ' +
        'balances, is not limited this way). ' +
        'A withdrawal keeps its flat fee and is checked against what the account held ' +
        'before it (EXCEEDS_AVAILABLE, details.available); a deposit keeps the GHS 5 ' +
        'floor (AMOUNT_TOO_SMALL). Transfer legs, Paystack charges and closures cannot ' +
        'be corrected (CANNOT_CORRECT). The balance and the running balance move with it.',
      txnIdParam,
      savingsTxn,
      savingsAccount,
    ),
    delete: {
      tags: ['Savings'],
      summary: 'Move a transaction to the trash (office only)',
      description:
        'Any live deposit or withdrawal of an active account, not only the newest: every ' +
        'later running balance is rewritten so the history stays consistent. Closures, ' +
        'transfer-created transactions, and one with a pending correction request cannot. ' +
        'Refused (CANNOT_TRASH) when the replay would overdraw the account at a later ' +
        'point. Trashing a withdrawal frees its 1-per-day slot and removes its fee.',
      security,
      requestParams: { path: txnIdParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse(
          'Moved to the trash',
          z.object({ txn: trashedSavingsTxn, account: savingsAccount }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse('CANNOT_TRASH'),
      },
    },
  },
  '/savings/accounts/{id}/transactions/{txnId}/restore': {
    post: {
      tags: ['Savings'],
      summary: 'Restore a trashed transaction (office only)',
      description:
        'Puts the transaction back in its place and rewrites every later running balance. ' +
        'Refused (CANNOT_RESTORE) if that would overdraw the account at a later point. ' +
        'Restoring a withdrawal re-claims its day — if the day is taken meanwhile the ' +
        'restore is refused (WITHDRAWAL_LIMIT).',
      security,
      requestParams: { path: txnIdParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ txn: savingsTxn, account: savingsAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED, WITHDRAWAL_LIMIT, or CONFLICT'),
        '422': errorResponse('CANNOT_RESTORE'),
      },
    },
  },
  '/savings/accounts/{id}/transactions/{txnId}/corrections': proposeCorrectionPathFor(
    'Savings',
    'a deposit or withdrawal',
    txnIdParam,
  ),
  '/savings/accounts/{id}/txns/{txnId}/receipt': {
    get: {
      tags: ['Savings'],
      summary: 'Printable receipt for a deposit, withdrawal or closure',
      description:
        'A4 receipt laid out to stay readable printed in black and white on office paper: ' +
        'receipt number, customer, account, the amount in a boxed headline, the ' +
        'product-specific detail rows, who recorded it, and signature lines. Reprints are ' +
        'identical: the receipt number is derived from the transaction id, and historical ' +
        'balances are rebuilt from the ledger rather than read off the current account. ' +
        'Binary response (application/pdf).' +
        ' balanceAfter is read straight off the stored transaction, so a reprint months ' +
        'later still shows the balance as it stood that day.',
      security,
      requestParams: {
        path: z.object({
          id: z.string().describe('Savings account id'),
          txnId: z.string(),
        }),
      },
      responses: {
        '200': {
          description: 'The receipt',
          content: { 'application/pdf': { schema: { type: 'string', format: 'binary' } } },
        },
        '403': errorResponse('CUSTOMER_NOT_ASSIGNED — collector reaching outside their round'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/savings/accounts/{id}/deposits': {
    post: {
      tags: ['Savings'],
      summary: 'Record a deposit (min GHS 5)',
      description:
        'Any collector or office staff. Idempotency key required — a ' +
        'retried request returns the original transaction.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(depositBody),
      responses: {
        '201': jsonResponse('Recorded', txnResult),
        '200': jsonResponse('Replay of an earlier request', txnResult),
        '422': errorResponse('ACCOUNT_NOT_ACTIVE'),
      },
    },
  },
  '/savings/accounts/{id}/withdrawals': {
    post: {
      tags: ['Savings'],
      summary: 'Process a withdrawal (office only)',
      description:
        'amount = what the customer receives; the flat GHS 10 fee is debited on top. ' +
        'Max one withdrawal per account per Accra day. The balance can never drop ' +
        'below the GHS 10 minimum except via closure. SMS notification sent. ' +
        'collectedBy records someone the holder sent to collect for them; the SMS and ' +
        'the receipt both name them.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(withdrawalBody),
      responses: {
        '201': jsonResponse('Processed', txnResult),
        '200': jsonResponse('Replay of an earlier request', txnResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('WITHDRAWAL_LIMIT — one per day'),
        '422': errorResponse('EXCEEDS_AVAILABLE (details.available) or ACCOUNT_NOT_ACTIVE'),
      },
    },
  },
  '/savings/renumber': {
    post: {
      tags: ['Savings'],
      summary: 'Renumber this month’s savings accounts into the continuing sequence (office only)',
      description:
        'Accounts opened this month under the old monthly-restart rule are renumbered, in ' +
        'opening order, to carry on from the highest number any earlier month reached, and ' +
        'the savings counter is set so the next account follows. `apply: false` previews and ' +
        'writes nothing; `apply: true` writes and is audited. Savings only. One run at a time.',
      security,
      requestBody: jsonBody(renumberBody),
      responses: {
        '200': jsonResponse(
          'What changed, or would',
          z.object({
            apply: z.boolean(),
            changes: z.array(z.object({ from: z.string(), to: z.string() })),
            counter: z.number().int().describe('The next account is this plus one'),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('RENUMBER_RUNNING'),
      },
    },
  },
  '/savings/accounts/{id}/number': {
    patch: {
      tags: ['Savings'],
      summary: 'Give the account a different number (office only)',
      description:
        'Typed by the office; the number must be in the current format (or a grandfathered ' +
        'ten-digit one) and not in use. Audited. A stop-gap for numbers issued under the ' +
        'monthly-restart rule, and the fix for a number quoted wrongly at opening.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(accountNumberBody),
      responses: {
        '200': jsonResponse('Renumbered', z.object({ account: savingsAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NUMBER_TAKEN'),
      },
    },
  },
  '/savings/accounts/{id}/close': {
    post: {
      tags: ['Savings'],
      summary: 'Close the account (office only)',
      description:
        'Releases the GHS 10 minimum balance; the flat GHS 10 fee applies to the ' +
        'closing payout too (GHS 200 balance → customer receives 190). `flagged` is ' +
        'true when the balance did not cover the fee.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse(
          'Closed',
          z.object({
            account: savingsAccount,
            fee: z.number().int(),
            payout: z.number().int(),
            flagged: z.boolean(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('ALREADY_CLOSED or WITHDRAWAL_LIMIT (same-day cash-out exists)'),
      },
    },
  },
};
