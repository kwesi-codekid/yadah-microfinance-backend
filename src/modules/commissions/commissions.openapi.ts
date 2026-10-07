import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { COMMISSION_CHANNELS, COMMISSION_REASONS, COMMISSION_SOURCES } from '../../models/index.js';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import { trashBody } from '../../schemas/common.js';
import { createMoveBody, listCommissionsQuery, listMovesQuery } from './commissions.schemas.js';

const security = [{ bearerAuth: [] }];
const money = z.number().int().describe('Integer pesewas');
const bySource = z.object({ susu: money, 'savings-fee': money, 'loan-fee': money });

const commission = z
  .object({
    id: z.string(),
    source: z.enum(COMMISSION_SOURCES),
    reason: z.enum(COMMISSION_REASONS),
    amount: money,
    customerId: z.string(),
    customerName: z.string().optional(),
    accountId: z.string().describe('The susu account, savings account or loan'),
    accountNumber: z.string().optional(),
    channel: z
      .enum(COMMISSION_CHANNELS)
      .describe('The company cash account’s channel the money sits in'),
    takenAt: z.iso.datetime(),
    recordedById: z.string().optional(),
    cycleNumber: z.number().int().optional().describe('Susu only'),
    dailyAmount: money.optional().describe('Susu only — the commission is one of these'),
    depositId: z.string().optional(),
    payoutId: z.string().optional(),
    savingsTxnId: z.string().optional(),
  })
  .meta({ id: 'Commission' });

const move = z
  .object({
    id: z.string(),
    amount: money,
    cashAccountId: z.string(),
    cashAccountName: z.string().optional(),
    occurredOn: z.string().describe('Accra day YYYY-MM-DD'),
    note: z.string().optional(),
    recordedById: z.string(),
    recordedByName: z.string().optional(),
    createdAt: z.iso.datetime(),
    deletedAt: z.iso.datetime().optional(),
    deleteReason: z.string().optional(),
  })
  .meta({ id: 'CommissionMove' });

export const commissionPaths: ZodOpenApiPathsObject = {
  '/commissions/summary': {
    get: {
      tags: ['Commissions'],
      summary: 'What the commission account holds, earned and moved (office)',
      security,
      responses: {
        '200': jsonResponse(
          'Summary',
          z.object({
            balance: money.describe('Earned − moved: what the commission account holds now'),
            earned: z.object({ total: money, bySource }),
            moved: money,
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/commissions': {
    get: {
      tags: ['Commissions'],
      summary: 'Commission account entries, newest first (office)',
      description:
        'One entry per susu cycle that charged commission, per savings withdrawal or closure ' +
        'that kept its fee, per loan that went out with a processing fee. `q` matches the ' +
        'customer’s name or phone, or an exact account number. `totals.bySource` ignores ' +
        'the source filter so every source’s figure is always there.',
      security,
      requestParams: { query: listCommissionsQuery },
      responses: {
        '200': jsonResponse(
          'Entries',
          z.object({
            items: z.array(commission),
            page: z.number().int(),
            limit: z.number().int(),
            total: z.number().int(),
            totals: z.object({ amount: money, bySource }),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/commissions/moves': {
    get: {
      tags: ['Commissions'],
      summary: 'Moves out of the commission account, newest first (office)',
      security,
      requestParams: { query: listMovesQuery },
      responses: {
        '200': jsonResponse(
          'Moves',
          z.object({
            items: z.array(move),
            page: z.number().int(),
            limit: z.number().int(),
            total: z.number().int(),
            totalAmount: money,
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
    post: {
      tags: ['Commissions'],
      summary: 'Move commission into a company cash account (office)',
      description:
        'The commission account goes down and the chosen cash account goes up by the same ' +
        'amount; the company’s cash total does not change. Never more than the commission ' +
        'account holds. Idempotent on idempotencyKey.',
      security,
      requestBody: jsonBody(createMoveBody),
      responses: {
        '201': jsonResponse('Moved', z.object({ move, balance: money, replayed: z.boolean() })),
        '200': jsonResponse('Replay of an earlier identical request', z.object({ move })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND — cash account'),
        '422': errorResponse('EXCEEDS_BALANCE (details.balance), ACCOUNT_CLOSED, or FUTURE_DATE'),
      },
    },
  },
  '/commissions/moves/{id}/trash': {
    post: {
      tags: ['Commissions'],
      summary: 'Undo a move made in error (office)',
      description: 'The money goes back into the commission account and out of the cash account.',
      security,
      requestParams: { path: z.object({ id: z.string() }) },
      requestBody: jsonBody(trashBody),
      responses: {
        '200': jsonResponse('Trashed', z.object({ move, balance: money })),
        '403': errorResponse('FORBIDDEN — office only'),
        '404': errorResponse('NOT_FOUND — or already in the trash'),
      },
    },
  },
};
