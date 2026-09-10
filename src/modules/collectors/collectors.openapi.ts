import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { jsonResponse } from '../../openapi/shared.js';
import { collectorDayQuery } from './collectors.schemas.js';

const security = [{ bearerAuth: [] }];
const tags = ['Collectors'];

const roundStop = z
  .object({
    customerId: z.string(),
    customerName: z.string(),
    phone: z.string(),
    residentialAddress: z.string().optional(),
    photoUrl: z.string().optional(),
    susu: z.array(
      z.object({
        accountId: z.string(),
        accountNumber: z.string(),
        dailyAmount: z.number().int(),
        depositsCount: z.number().int(),
        daysRemainingInCycle: z.number().int(),
        collectedToday: z.number().int(),
        stillDue: z.number().int().describe("One day's deposit less anything already taken today"),
      }),
    ),
    totalStillDue: z.number().int(),
    done: z.boolean().describe("True once every susu account has today's deposit"),
  })
  .meta({ id: 'RoundStop' });

const collectorRound = z
  .object({
    date: z.string(),
    collectorId: z.string(),
    stops: z.array(roundStop),
    totals: z.object({
      customers: z.number().int(),
      customersDone: z.number().int(),
      susuAccounts: z.number().int(),
      expectedTotal: z.number().int(),
      collectedTotal: z.number().int(),
      stillDueTotal: z.number().int(),
    }),
  })
  .meta({ id: 'CollectorRound' });

const collectorDay = z
  .object({
    date: z.string(),
    collectorId: z.string(),
    susu: z.object({ count: z.number().int(), amount: z.number().int() }),
    savings: z.object({ count: z.number().int(), amount: z.number().int() }),
    cashTotal: z.number().int().describe('CASH only — what must be handed over'),
    entries: z.array(
      z.object({
        id: z.string(),
        product: z.enum(['susu', 'savings']),
        accountId: z.string(),
        accountNumber: z.string(),
        customerId: z.string(),
        customerName: z.string(),
        amount: z.number().int(),
        channel: z.string(),
        at: z.iso.datetime(),
      }),
    ),
    reconciliation: z
      .object({ id: z.string(), status: z.string(), declaredAmount: z.number().int() })
      .nullable()
      .describe('Null until the collector declares the day'),
  })
  .meta({ id: 'CollectorDay' });

export const collectorPaths: ZodOpenApiPathsObject = {
  '/collectors/me/round': {
    get: {
      tags,
      summary: "Today's round: who still owes a susu deposit",
      description:
        'The field app home screen. Assigned customers with an open susu account, how much ' +
        'is still due at each stop, and where to find them.\n\n' +
        'Susu is the only product with a daily schedule — savings deposits are voluntary ' +
        'and loans/hire purchase are collected at the office, so neither can be "due" on a ' +
        'round. Customers with no open susu account are omitted. A deposit recorded by ANY ' +
        'collector satisfies the day.\n\n' +
        'Collectors are pinned to themselves; office roles must pass `collectorId`.',
      security,
      requestParams: { query: collectorDayQuery },
      responses: { '200': jsonResponse('Round sheet', collectorRound) },
    },
  },
  '/collectors/me/day': {
    get: {
      tags,
      summary: 'What has been collected so far today, susu and savings together',
      description:
        'The other half of the field app home screen, and the cross-check before ' +
        'declaring. `cashTotal` counts CASH only, matching what reconciliation expects to ' +
        'be handed over — a mobile money deposit is real money but never reaches the ' +
        "collector's pocket.\n\n" +
        '`reconciliation` is null until the day has been declared.',
      security,
      requestParams: { query: collectorDayQuery },
      responses: { '200': jsonResponse('Day view', collectorDay) },
    },
  },
};
