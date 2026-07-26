import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  depositBody,
  listAccountsQuery,
  listTxnsQuery,
  openAccountBody,
  withdrawalBody,
} from './savings.schemas.js';

const savingsAccount = z
  .object({
    id: z.string(),
    accountNumber: z.string().describe('10-digit randomized, unique'),
    customerId: z.string(),
    customerName: z.string().optional().describe('On list responses, for display'),
    balance: z.number().int().describe('Pesewas'),
    availableToWithdraw: z
      .number()
      .int()
      .describe('balance − GHS 50 min balance − GHS 10 fee, never negative'),
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
    channel: z.enum(['cash', 'paystack', 'momo']),
    accraDay: z.string().describe('Accra calendar day, YYYY-MM-DD'),
    recordedById: z.string(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SavingsTxn' });

const txnResult = z.object({ txn: savingsTxn, account: savingsAccount, replayed: z.boolean() });
const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Savings account id') });

export const savingsPaths: ZodOpenApiPathsObject = {
  '/savings/accounts': {
    post: {
      tags: ['Savings'],
      summary: 'Open a savings account (office only)',
      description: 'Optional initialDeposit (min GHS 10) is recorded atomically with the opening.',
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
        'name, phone, or account-number prefix.',
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
  },
  '/savings/accounts/{id}/transactions': {
    get: {
      tags: ['Savings'],
      summary: 'Transaction history / statement',
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
  '/savings/accounts/{id}/deposits': {
    post: {
      tags: ['Savings'],
      summary: 'Record a deposit (min GHS 10)',
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
        'below the GHS 50 minimum except via closure. SMS notification sent.',
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
  '/savings/accounts/{id}/close': {
    post: {
      tags: ['Savings'],
      summary: 'Close the account (office only)',
      description:
        'Releases the GHS 50 minimum balance; the flat GHS 10 fee applies to the ' +
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
