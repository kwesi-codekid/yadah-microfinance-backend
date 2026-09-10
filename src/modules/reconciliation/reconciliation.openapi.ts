import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { ROLES } from '../../models/shared.js';
import { errorResponse, jsonBody, jsonResponse } from '../../openapi/shared.js';
import {
  confirmDayBody,
  declareDayBody,
  expectedQuery,
  listReconciliationsQuery,
  varianceReportQuery,
} from './reconciliation.schemas.js';

const security = [{ bearerAuth: [] }];
const idParam = z.object({ id: z.string().describe('Reconciliation id') });

const expectedCash = z
  .object({
    collectorId: z.string(),
    accraDay: z.string(),
    susu: z.number().int().describe('Cash-channel susu deposits, pesewas'),
    savings: z.number().int().describe('Cash-channel savings deposits, pesewas'),
    total: z.number().int(),
    entries: z.number().int().describe('How many deposits make up the total'),
  })
  .meta({ id: 'ExpectedCash' });

const reconciliation = z
  .object({
    id: z.string(),
    collectorId: z.string(),
    collectorName: z.string().optional(),
    collectorRole: z
      .enum(ROLES)
      .optional()
      .describe(
        'What the person who declared the day does here. The handover runs one rank at a time: a teller counts in a collector, the office counts in a teller.',
      ),
    accraDay: z.string(),
    expectedAmount: z.number().int().describe('What the system says was collected in cash'),
    expectedBreakdown: z.object({ susu: z.number().int(), savings: z.number().int() }),
    declaredAmount: z.number().int().describe('What the collector counted in hand'),
    declaredAt: z.iso.datetime(),
    declaredNote: z.string().optional(),
    receivedAmount: z.number().int().optional().describe('What the office receiver took in'),
    receivedById: z.string().optional(),
    receivedAt: z.iso.datetime().optional(),
    variance: z
      .number()
      .int()
      .optional()
      .describe('receivedAmount − expectedAmount. Negative = short, positive = over'),
    declaredVsReceived: z
      .number()
      .int()
      .optional()
      .describe('receivedAmount − declaredAmount: a miscount between collector and receiver'),
    varianceReason: z.string().optional(),
    status: z.enum(['declared', 'reconciled']),
  })
  .meta({ id: 'Reconciliation' });

const reconciliationResult = z.object({ reconciliation });

const reconciliationList = z.object({
  items: z.array(reconciliation),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int(),
});

const varianceRow = z.object({
  collectorId: z.string(),
  collectorName: z.string(),
  days: z.number().int(),
  daysWithVariance: z.number().int(),
  totalExpected: z.number().int(),
  totalReceived: z.number().int(),
  netVariance: z.number().int().describe('Net across the period; negative = short overall'),
  totalShort: z.number().int().describe('Sum of shortfalls alone'),
  totalOver: z.number().int(),
});

export const reconciliationPaths: ZodOpenApiPathsObject = {
  '/reconciliation/expected': {
    get: {
      tags: ['Reconciliation'],
      summary: 'What the system says a collector took in cash today',
      description:
        'The collector’s cross-check before counting. Cash channel only — a Paystack or ' +
        'momo deposit never passed through their hands, and a transfer leg is not cash. ' +
        'Loans and hire purchase are excluded entirely: those are collected at the office. ' +
        'Collectors are pinned to themselves; office roles must pass collectorId.',
      security,
      requestParams: { query: expectedQuery },
      responses: {
        '200': jsonResponse('Expected cash for the day', expectedCash),
        '422': errorResponse('COLLECTOR_REQUIRED — office roles must name a collectorId'),
      },
    },
  },
  '/reconciliation/variances': {
    get: {
      tags: ['Reconciliation'],
      summary: 'Cash variance report (office only)',
      description:
        'Who is short, how often, and by how much, grouped by collector and sorted worst ' +
        'first. Shortfalls and overages are reported separately as well as netted — a ' +
        'collector short GHS 50 one day and over GHS 50 the next is not the same as one ' +
        'who always balances. Pass format=csv or format=xlsx to download.',
      security,
      requestParams: { query: varianceReportQuery },
      responses: {
        '200': jsonResponse(
          'Variances by collector',
          z.object({
            period: z.object({ from: z.string().nullable(), to: z.string().nullable() }),
            rows: z.array(varianceRow),
            totals: z.object({
              netVariance: z.number().int(),
              totalShort: z.number().int(),
              totalOver: z.number().int(),
              daysWithVariance: z.number().int(),
            }),
          }),
        ),
        '403': errorResponse('FORBIDDEN — office only'),
      },
    },
  },
  '/reconciliation/declare': {
    post: {
      tags: ['Reconciliation'],
      summary: 'Collector closes their day with the cash counted (collector only)',
      description:
        'Step 1 of the handover. The declared figure is recorded as given — a mismatch ' +
        'with the system total is information for the receiver, not an error to fix here. ' +
        'One reconciliation per collector per Accra day; backdating a late close is ' +
        'allowed, closing a future day is not.',
      security,
      requestBody: jsonBody(declareDayBody),
      responses: {
        '201': jsonResponse('Declared, awaiting the office', reconciliationResult),
        '403': errorResponse('FORBIDDEN — only a collector closes their own day'),
        '409': errorResponse('ALREADY_DECLARED (details.reconciliationId, details.status)'),
        '422': errorResponse('FUTURE_DAY'),
      },
    },
  },
  '/reconciliation/{id}/confirm': {
    post: {
      tags: ['Reconciliation'],
      summary: 'Office receiver confirms what was turned in (office only)',
      description:
        'Step 2 of the handover. The expected total is RECOMPUTED here rather than reused ' +
        'from declaration, so a deposit corrected in between is reflected in the variance. ' +
        'A shortage is recorded, never blocked — the collector keeps working and the gap ' +
        'surfaces in GET /reconciliation/variances. A collector cannot confirm their own cash.',
      security,
      requestParams: { path: idParam },
      requestBody: jsonBody(confirmDayBody),
      responses: {
        '200': jsonResponse('Reconciled', reconciliationResult),
        '403': errorResponse('FORBIDDEN — office only, or SELF_RECEIPT'),
        '404': errorResponse('NOT_FOUND'),
        '409': errorResponse('ALREADY_RECONCILED'),
      },
    },
  },
  '/reconciliation': {
    get: {
      tags: ['Reconciliation'],
      summary: 'List day closures',
      description:
        'Collectors see only their own days; office roles see all and may filter by ' +
        'collectorId, status, Accra-day range, or varianceOnly=true. Pass format=csv or ' +
        'format=xlsx to download.',
      security,
      requestParams: { query: listReconciliationsQuery },
      responses: { '200': jsonResponse('Paginated reconciliations', reconciliationList) },
    },
  },
  '/reconciliation/{id}': {
    get: {
      tags: ['Reconciliation'],
      summary: 'Get one day closure',
      security,
      requestParams: { path: idParam },
      responses: {
        '200': jsonResponse('The reconciliation', reconciliationResult),
        '403': errorResponse('FORBIDDEN — not your reconciliation'),
        '404': errorResponse('NOT_FOUND'),
      },
    },
  },
};
