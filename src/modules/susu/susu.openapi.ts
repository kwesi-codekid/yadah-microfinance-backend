import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  collectAllBody,
  depositBody,
  listAccountsQuery,
  listDepositsQuery,
  openAccountBody,
  summaryQuery,
} from './susu.schemas.js';

const susuAccount = z
  .object({
    id: z.string(),
    accountNumber: z.string().describe('6-digit randomized, unique'),
    customerId: z.string(),
    dailyAmount: z.number().int().describe('Pesewas. Immutable for the life of the cycle.'),
    depositsCount: z.number().int(),
    cycleTarget: z.literal(31),
    totalDeposited: z.number().int(),
    status: z.enum(['active', 'completed', 'closed']),
    commissionAmount: z.number().int().optional().describe('Set at closure: 1 day’s deposit'),
    payoutAmount: z.number().int().optional().describe('Set at closure: total − commission'),
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
    channel: z.enum(['cash', 'paystack', 'momo']),
    collectAllBatchId: z.string().optional(),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'SusuDeposit' });

const accountResult = z.object({ account: susuAccount });
const depositResult = z.object({
  deposit: susuDeposit,
  account: susuAccount,
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
        'One account = one cycle of 31 deposits at a fixed daily amount. The daily ' +
        'amount is immutable — changing it means closing and opening a new account. ' +
        'A customer may hold multiple concurrent accounts.',
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
      description: 'Collectors see only accounts of their assigned customers.',
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
  '/susu/accounts/{id}': {
    get: {
      tags: ['Susu'],
      summary: 'Account detail with cycle progress',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The account', accountResult),
        '403': errorResponse('FORBIDDEN — not your customer'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
  '/susu/accounts/{id}/deposits': {
    get: {
      tags: ['Susu'],
      summary: 'Deposit history (statement)',
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
        'Collectors (own customers) and office staff. Send daysCovered ≥ 2 for a ' +
        'catch-up covering missed days — the amount is computed server-side as ' +
        'dailyAmount × daysCovered. Requires an idempotency key: a retried request ' +
        'returns the original deposit (200) instead of double-recording. Reaching ' +
        '31 deposits completes the cycle. SMS receipt sent to the customer.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(depositBody),
      responses: {
        '201': jsonResponse('Recorded', depositResult),
        '200': jsonResponse('Replay of an earlier request', depositResult),
        '409': errorResponse('CONFLICT — concurrent update, retry'),
        '422': errorResponse('ACCOUNT_NOT_ACTIVE or EXCEEDS_REMAINING (details.remaining)'),
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
  '/susu/accounts/{id}/close': {
    post: {
      tags: ['Susu'],
      summary: 'Close account = withdrawal (office only)',
      description:
        'Payout = total deposits − exactly 1 day’s commission, regardless of exit ' +
        'day. Never negative; `flagged` is true when deposits did not cover the ' +
        'commission. Sends the withdrawal SMS.',
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
