import { z } from 'zod';
import { CYCLE_MONTHS } from '../../lib/account-number.js';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { trashBody } from '../../schemas/common.js';
import {
  collectAllBody,
  depositBody,
  listAccountsQuery,
  listDepositsQuery,
  listTrashQuery,
  openAccountBody,
  partialWithdrawalBody,
  payoutBody,
  summaryQuery,
  updateDepositBody,
} from './susu.schemas.js';

const susuAccount = z
  .object({
    id: z.string(),
    accountNumber: z
      .string()
      .describe(
        'SU + YYMM + 4-digit monthly sequence + the cycle month, e.g. SU26090005-SEP. ' +
          'Accounts opened before the cycle month carry no suffix; accounts opened ' +
          'before the scheme keep their legacy 6 random digits.',
      ),
    cycleMonth: z
      .enum(CYCLE_MONTHS)
      .optional()
      .describe(
        'The month the cycle is called, which need not be the month the number was ' +
          'issued in — a cycle opened in late August for September is SEP. Absent on ' +
          'accounts opened before the field existed.',
      ),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses, for display'),
    dailyAmount: z.number().int().describe('Pesewas. Immutable for the life of the cycle.'),
    depositsCount: z.number().int(),
    cycleTarget: z.literal(31),
    totalDeposited: z
      .number()
      .int()
      .describe('Running total paid IN over the cycle — never decreases'),
    withdrawnAmount: z.number().int().describe('Total taken out by partial withdrawals'),
    balance: z.number().int().describe('totalDeposited − withdrawnAmount: what the account holds'),
    availableToWithdraw: z
      .number()
      .int()
      .describe('Withdrawable today; one day’s amount stays reserved for the closing commission'),
    status: z.enum(['active', 'completed', 'pending-payout', 'closed', 'terminated']),
    commissionAmount: z
      .number()
      .int()
      .optional()
      .describe('Set when the account stops: 1 day’s deposit'),
    payoutAmount: z
      .number()
      .int()
      .optional()
      .describe('Set when the account stops: total − commission'),
    payoutRemaining: z
      .number()
      .int()
      .describe('Undisbursed value awaiting withdrawal (pending-payout)'),
    openedAt: z.iso.datetime(),
    closedAt: z.iso.datetime().optional(),
  })
  .meta({ id: 'SusuAccount' });

const susuDeposit = z
  .object({
    id: z.string(),
    accountId: z.string(),
    customerId: z.string(),
    collectorId: z.string().describe('User who recorded it (collector or office staff)'),
    amount: z.number().int(),
    daysCovered: z.number().int(),
    seqStart: z.number().int().describe('1-based position in the 31-deposit cycle'),
    seqEnd: z.number().int(),
    channel: z
      .enum(['cash', 'paystack', 'momo', 'transfer'])
      .describe("'transfer' = created by an internal transfer"),
    collectAllBatchId: z.string().optional(),
    carriedToDepositId: z
      .string()
      .optional()
      .describe('Set when part of this payment ran past the cycle and opened a new account'),
    carriedToAccountId: z.string().optional(),
    carriedFromDepositId: z
      .string()
      .optional()
      .describe('Set on the follow-on half: the deposit whose cycle overflowed into this one'),
    carriedFromAccountId: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SusuDeposit' });

const trashedSusuAccount = susuAccount.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const trashedSusuDeposit = susuDeposit.extend({
  deletedAt: z.iso.datetime(),
  deletedById: z.string().optional(),
  deleteReason: z.string().optional(),
});

const depositIdParam = z.object({
  id: z.string().describe('Susu account id'),
  depositId: z.string().describe('Deposit id'),
});

const accountResult = z.object({ account: susuAccount });
const depositResult = z.object({
  deposit: susuDeposit.describe('The leg recorded against the account named in the path'),
  account: susuAccount,
  legs: z
    .array(
      z.object({
        deposit: susuDeposit,
        account: susuAccount,
        carried: z.boolean().describe('True when this leg’s account was opened by this payment'),
      }),
    )
    .describe('Every leg of the payment, oldest first. Longer than one only on a carry.'),
  totalAmount: z.number().int().describe('Pesewas across all legs — what the customer handed over'),
  openedAccounts: z
    .array(susuAccount)
    .describe('Accounts this payment had to open. Empty on the ordinary path.'),
  replayed: z.boolean().describe('True when this response replays an earlier identical request'),
});
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Susu account id') });

export const susuPaths: ZodOpenApiPathsObject = {
  '/susu/accounts': {
    post: {
      tags: ['Susu'],
      summary: 'Open a susu account (office only)',
      description:
        'One account = one cycle of 31 deposits at a fixed daily amount (min GHS 10). ' +
        'The daily amount is immutable — changing it means closing and opening a new ' +
        'account. A customer may hold multiple concurrent accounts.',
      security,
      requestBody: jsonBody(openAccountBody),
      responses: {
        '201': jsonResponse('Opened', accountResult),
        '404': errorResponse('NOT_FOUND — customer'),
        '422': errorResponse('CUSTOMER_INACTIVE'),
      },
    },
    get: {
      tags: ['Susu'],
      summary: 'List accounts',
      description:
        'All roles see all accounts. `search` is fuzzy: typo-tolerant customer ' +
        'name, phone, or account-number prefix. Pass format=csv or format=xlsx ' +
        'to download a spreadsheet (pagination is ignored; capped at 10,000 rows).',
      security,
      requestParams: { query: listAccountsQuery },
      responses: {
        '200': jsonResponse(
          'Paginated accounts',
          z.object({
            items: z.array(susuAccount),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
  },
  '/susu/accounts/trash': {
    get: {
      tags: ['Susu'],
      summary: 'List trashed susu accounts (office only)',
      description: 'Accounts moved to the trash, most recently trashed first.',
      security,
      requestParams: { query: listTrashQuery },
      responses: {
        '200': jsonResponse(
          'Paginated trashed accounts',
          z.object({
            items: z.array(trashedSusuAccount),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/susu/accounts/{id}': {
    get: {
      tags: ['Susu'],
      summary: 'Account detail with cycle progress',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The account', accountResult),

        '404': errorResponse('NOT_FOUND'),
      },
    },
    delete: {
      tags: ['Susu'],
      summary: 'Move a susu account to the trash (office only)',
      description:
        'Only empty, unused accounts qualify: active status with no deposits ever ' +
        'recorded and nothing awaiting payout. Used accounts must go through ' +
        'close/terminate instead. An optional reason is stored with the trashed ' +
        'account, which disappears from normal endpoints until restored.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Moved to the trash', z.object({ account: trashedSusuAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '422': errorResponse(
          'CANNOT_TRASH (details.status, details.depositsCount, details.totalDeposited, ' +
            'details.payoutRemaining, details.depositRecords)',
        ),
      },
    },
  },
  '/susu/accounts/{id}/restore': {
    post: {
      tags: ['Susu'],
      summary: 'Restore a susu account from the trash (office only)',
      description: 'Clears the trash fields; the account reappears on normal endpoints.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('Restored', accountResult),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED — the account is not in the trash'),
      },
    },
  },
  '/susu/accounts/{id}/deposits': {
    get: {
      tags: ['Susu'],
      summary: 'Deposit history (statement)',
      description:
        'Pass format=csv or format=xlsx to download a spreadsheet (pagination is ' +
        'ignored; capped at 10,000 rows).',
      security,
      requestParams: { path: idParam, query: listDepositsQuery },
      responses: {
        '200': jsonResponse(
          'Deposits, newest first',
          z.object({
            items: z.array(susuDeposit),
            page: z.number(),
            limit: z.number(),
            total: z.number(),
          }),
        ),
      },
    },
    post: {
      tags: ['Susu'],
      summary: 'Record a deposit (single day or catch-up)',
      description:
        'Any collector or office staff. Send the cash received as `amount` ' +
        '(pesewas) — it must be a multiple of the daily amount, and the days ' +
        'covered are derived from it (one multiple = today, more = catch-up on ' +
        'missed days). Requires an idempotency key: a retried request returns the ' +
        'original deposit (200) instead of double-recording. Reaching 31 deposits ' +
        'completes the cycle. SMS receipt sent to the customer. ' +
        'CARRY-FORWARD: a payment worth more days than the cycle has left is no ' +
        'longer refused. The days that fit finish the current cycle; the remainder ' +
        'opens a new account for the same customer at the same daily amount, ' +
        'numbered with the CURRENT month’s suffix, and is recorded there. Read ' +
        '`legs` for every half and `openedAccounts` for anything opened. `deposit` ' +
        'and `account` are unchanged — they are always the first leg.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(depositBody),
      responses: {
        '201': jsonResponse('Recorded', depositResult),
        '200': jsonResponse('Replay of an earlier request', depositResult),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse(
          'ACCOUNT_NOT_ACTIVE, AMOUNT_MISMATCH (details.dailyAmount), or ' +
            'EXCEEDS_CARRY_LIMIT (details.daysCovered, details.remaining, ' +
            'details.wouldOpen, details.maxCarryAccounts) when one payment would ' +
            'have to open more than one new account — almost always a mistyped amount',
        ),
      },
    },
  },
  '/susu/accounts/{id}/deposits/trash': {
    get: {
      tags: ['Susu'],
      summary: 'List trashed deposits of an account (office only)',
      security,
      requestParams: { path: idParam, query: listTrashQuery },
      responses: {
        '200': jsonResponse(
          'Trashed deposits, most recently trashed first',
          z.object({
            items: z.array(trashedSusuDeposit),
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
  '/susu/accounts/{id}/deposits/{depositId}': {
    patch: {
      tags: ['Susu'],
      summary: 'Correct the most recent deposit’s amount (office only)',
      description:
        'Data-entry fixes. Only the most recent deposit of an open account can ' +
        'change; the new amount must be a multiple of the daily amount and the days ' +
        'covered are re-derived. Account counters adjust atomically, including ' +
        'completing or un-completing the 31-day cycle. Transfer-created deposits ' +
        'are immutable.',
      security,
      requestParams: { path: depositIdParam },
      requestBody: jsonBody(updateDepositBody),
      responses: {
        '200': jsonResponse(
          'Corrected',
          depositResult.describe('A correction never carries, so `legs` always has one entry'),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse(
          'CANNOT_TRASH (not the latest deposit / closed account / transfer-created), ' +
            'AMOUNT_MISMATCH (details.dailyAmount), or EXCEEDS_REMAINING (details.remaining)',
        ),
      },
    },
    delete: {
      tags: ['Susu'],
      summary: 'Move the most recent deposit to the trash (office only)',
      description:
        'Reverses the account counters atomically (deposits count, total ' +
        'deposited, completed → active when the 31st deposit is removed). Only the ' +
        'most recent deposit of an open account qualifies; transfer-created ' +
        'deposits are immutable.',
      security,
      requestParams: { path: depositIdParam },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse(
          'Moved to the trash',
          z.object({ deposit: trashedSusuDeposit, account: susuAccount }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse('CANNOT_TRASH'),
      },
    },
  },
  '/susu/accounts/{id}/deposits/{depositId}/restore': {
    post: {
      tags: ['Susu'],
      summary: 'Restore a trashed deposit (office only)',
      description:
        'Re-applies the deposit. Only possible while its cycle positions are still ' +
        'free (nothing newer recorded since the trash).',
      security,
      requestParams: { path: depositIdParam },
      responses: {
        '200': jsonResponse('Restored', z.object({ deposit: susuDeposit, account: susuAccount })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('NOT_TRASHED or CONFLICT'),
        '422': errorResponse('CANNOT_RESTORE (details.seqStart, details.depositsCount)'),
      },
    },
  },
  '/susu/collect-all': {
    post: {
      tags: ['Susu'],
      summary: 'Collect one cash amount across all active accounts (atomic)',
      description:
        'Splits one day’s deposit into every active account of the customer in a ' +
        'single all-or-nothing transaction. The amount must equal the sum of the ' +
        'active accounts’ daily amounts — on mismatch the error details carry the ' +
        'required total and per-account breakdown. One itemized SMS receipt.',
      security,
      requestBody: jsonBody(collectAllBody),
      responses: {
        '201': jsonResponse(
          'All deposits recorded',
          z.object({
            batchId: z.string(),
            totalAmount: z.number().int(),
            deposits: z.array(susuDeposit),
            accounts: z.array(susuAccount),
            replayed: z.boolean(),
          }),
        ),
        '422': errorResponse(
          'NO_ACTIVE_ACCOUNTS or AMOUNT_MISMATCH (details.required, details.breakdown)',
        ),
      },
    },
  },
  '/susu/accounts/{id}/deposits/{depositId}/receipt': {
    get: {
      tags: ['Susu'],
      summary: 'Printable deposit receipt',
      description:
        'A4 receipt laid out to stay readable printed in black and white on office paper: ' +
        'receipt number, customer, account, the amount in a boxed headline, the ' +
        'product-specific detail rows, who recorded it, and signature lines. Reprints are ' +
        'identical: the receipt number is derived from the transaction id, and historical ' +
        'balances are rebuilt from the ledger rather than read off the current account. ' +
        'Binary response (application/pdf).' +
        ' Available to collectors as well as the office — whoever took the cash in the ' +
        'field has to be able to hand over a receipt for it.',
      security,
      requestParams: {
        path: z.object({
          id: z.string().describe('Susu account id'),
          depositId: z.string(),
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
  '/susu/accounts/{id}/withdrawals/{payoutId}/receipt': {
    get: {
      tags: ['Susu'],
      summary: 'Printable withdrawal or payout receipt',
      description:
        'Covers both kinds of money leaving a susu account: a partial withdrawal that ' +
        'leaves the account open (which states plainly that no commission was taken), and ' +
        'the payout that ends it (which shows the one-day commission). ' +
        'Binary response (application/pdf).',
      security,
      requestParams: {
        path: z.object({
          id: z.string().describe('Susu account id'),
          payoutId: z.string(),
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
  '/susu/accounts/{id}/withdraw': {
    post: {
      tags: ['Susu'],
      summary: 'Withdraw part of the balance, keeping the account open (office only)',
      description:
        'Client decision 2026-08-21, replacing the rule that any withdrawal closed the ' +
        'account. NO commission is taken here — commission is exactly one cycle-day’s ' +
        'amount, charged once, at closure. The cycle is untouched: days already paid stay ' +
        'paid, so depositsCount and the 31-day target do not move. One day’s amount stays ' +
        'reserved in the account so the closing commission remains collectible, which is ' +
        'why availableToWithdraw is balance − dailyAmount. Idempotent on idempotencyKey; ' +
        'sends an SMS confirming the account stays open.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(partialWithdrawalBody),
      responses: {
        '201': jsonResponse(
          'Withdrawn',
          z.object({
            account: susuAccount,
            amount: z.number().int(),
            replayed: z.boolean(),
          }),
        ),
        '200': jsonResponse('Replay of an earlier identical request', z.object({})),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('CONFLICT — account changed concurrently, retry'),
        '422': errorResponse(
          'ACCOUNT_NOT_OPEN, or EXCEEDS_AVAILABLE ' +
            '(details.available, details.balance, details.reserved)',
        ),
      },
    },
  },
  '/susu/accounts/{id}/close': {
    post: {
      tags: ['Susu'],
      summary: 'Close the account and pay out (office only)',
      description:
        'Payout = BALANCE − exactly 1 day’s commission, regardless of exit day and ' +
        'regardless of how many partial withdrawals happened along the way — the ' +
        'commission is charged once per cycle, here. The balance must cover it, ' +
        'otherwise the request is refused (COMMISSION_NOT_COVERED) and the account ' +
        'can only be terminated. The cash disbursement is recorded and appears in ' +
        'the transactions feed. Sends the withdrawal SMS.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse(
          'Closed',
          z.object({
            account: susuAccount,
            commission: z.number().int(),
            payout: z.number().int(),
            flagged: z.boolean(),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('ALREADY_CLOSED'),
        '422': errorResponse('COMMISSION_NOT_COVERED (details.balance, details.dailyAmount)'),
      },
    },
  },
  '/susu/accounts/{id}/terminate': {
    post: {
      tags: ['Susu'],
      summary: 'Terminate an account that cannot cover the commission (office only)',
      description:
        'Escape hatch for accounts whose deposits are below one day’s amount ' +
        '(including empty accounts): refunds everything deposited, charges no ' +
        'commission, and sets the account to `terminated`. Accounts that can cover ' +
        'the commission must be closed normally. The refund is recorded and appears ' +
        'in the transactions feed.',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse(
          'Terminated',
          z.object({ account: susuAccount, refund: z.number().int() }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
        '409': errorResponse('ALREADY_CLOSED'),
        '422': errorResponse('CANNOT_TERMINATE (details.totalDeposited, details.dailyAmount)'),
      },
    },
  },
  '/susu/accounts/{id}/payout': {
    post: {
      tags: ['Susu'],
      summary: 'Pay out a pending-payout balance in cash (office only)',
      description:
        'For accounts stopped with value still awaiting withdrawal (e.g. the excess ' +
        'after a loan repayment via susu closure). Omit amount to pay out everything; ' +
        'the account closes when its remaining value reaches zero.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(payoutBody),
      responses: {
        '201': jsonResponse(
          'Paid out',
          z.object({ account: susuAccount, amount: z.number().int(), replayed: z.boolean() }),
        ),
        '200': jsonResponse(
          'Replay of an earlier request',
          z.object({ account: susuAccount, amount: z.number().int(), replayed: z.boolean() }),
        ),
        '422': errorResponse('NOT_PENDING_PAYOUT or EXCEEDS_PAYOUT (details.payoutRemaining)'),
      },
    },
  },
  '/susu/summary': {
    get: {
      tags: ['Susu'],
      summary: 'Daily collection summary (reconciliation)',
      description:
        'Deposits recorded on an Accra calendar day. Collectors see their own; ' +
        'office roles may pass collectorId or omit it for everyone.',
      security,
      requestParams: { query: summaryQuery },
      responses: {
        '200': jsonResponse(
          'Summary',
          z.object({
            date: z.string(),
            collectorId: z.string().nullable(),
            depositCount: z.number().int(),
            totalCollected: z.number().int(),
            deposits: z.array(
              z.object({
                depositId: z.string(),
                accountId: z.string(),
                customerId: z.string(),
                customerName: z.string(),
                collectorId: z.string(),
                amount: z.number().int(),
                daysCovered: z.number().int(),
                at: z.iso.datetime(),
              }),
            ),
          }),
        ),
      },
    },
  },
};
