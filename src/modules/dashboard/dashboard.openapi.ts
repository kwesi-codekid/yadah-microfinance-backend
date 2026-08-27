import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import { txnTotals, unifiedTransaction } from '../reports/reports.openapi.js';

const security = [{ bearerAuth: [] }];
const tags = ['Dashboard'];

const countAmount = z.object({ count: z.number().int(), amount: z.number().int() });

const dashboardSummary = z
  .object({
    kpis: z
      .object({
        totalCustomers: z.number().int().describe("Customers with status 'active'"),
        activeAccounts: z
          .number()
          .int()
          .describe('Open susu cycles + active savings + open loans + open HP agreements'),
        pendingSusuPayouts: countAmount.describe('Completed cycles not yet paid out'),
        amountCollectedToday: z.number().int().describe("Today's cash in, pesewas"),
        amountCollectedChangePercent: z
          .number()
          .nullable()
          .describe(
            'Change against yesterday, one decimal. NULL when yesterday took nothing — ' +
              'there is no percentage change from zero; render a dash, not 0% or ∞.',
          ),
        inArrears: z.number().int().describe('Loans in arrears + HP agreements in arrears'),
      })
      .describe(
        'The headline tiles, flattened. Every value here is derived from the blocks ' +
          'below and repeated only so the frontend need not redo the arithmetic.',
      ),
    today: z.object({
      day: z.string().describe('Accra calendar day, YYYY-MM-DD'),
      cashIn: countAmount,
      cashOut: countAmount,
      internalMoves: countAmount.describe('Transfer legs — excluded from cash totals'),
      in: z.object({
        susuDeposits: countAmount,
        savingsDeposits: countAmount,
        loanRepayments: countAmount,
        hpPayments: countAmount,
      }),
      out: z.object({
        susuPayouts: countAmount,
        savingsWithdrawals: countAmount,
        loanDisbursements: countAmount,
      }),
    }),
    yesterday: z.object({ day: z.string(), cashIn: countAmount }),
    monthToDate: z.object({
      from: z.string(),
      to: z.string(),
      susuCommission: countAmount,
      savingsFees: countAmount,
      outrightSalesProfit: countAmount,
      totalRevenue: z.number().int(),
    }),
    portfolio: z.object({
      customersActive: z.number().int(),
      susu: z.object({
        activeAccounts: z.number().int(),
        completedAwaitingClosure: z.number().int(),
        valueHeld: z.number().int().describe('Deposits less anything already withdrawn'),
        pendingPayout: countAmount,
      }),
      savings: z.object({
        activeAccounts: z.number().int(),
        totalBalance: z.number().int(),
        byType: z.object({ standard: countAmount, student: countAmount }),
      }),
      loans: z.object({
        active: z.number().int(),
        arrears: z.number().int(),
        outstanding: z.number().int(),
      }),
      hirePurchase: z.object({
        active: z.number().int(),
        inArrears: z.number().int(),
        outstanding: z.number().int(),
      }),
    }),
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: 'DashboardSummary' });

const seriesPoint = z
  .object({
    key: z.string().describe("'2026-08-27' (day), '2026-W35' (ISO week), or '2026-08' (month)"),
    cashIn: countAmount,
    cashOut: countAmount,
    internalMoves: countAmount,
    expected: z
      .number()
      .int()
      .describe('Field cash the system recorded collectors taking in, reconciled days only'),
    received: z.number().int().describe('What the office confirmed was turned in'),
  })
  .meta({ id: 'CashSeriesPoint' });

const cashSeries = z
  .object({
    from: z.string(),
    to: z.string(),
    bucket: z.enum(['day', 'week', 'month']),
    points: z
      .array(seriesPoint)
      .describe('Every bucket in the range, in order. Empty buckets are present with zeroes.'),
    totals: z.object({
      cashIn: countAmount,
      cashOut: countAmount,
      internalMoves: countAmount,
      expected: z.number().int(),
      received: z.number().int(),
    }),
  })
  .meta({ id: 'CashSeries' });

const collectionEfficiency = z
  .object({
    from: z.string(),
    to: z.string(),
    expected: z.number().int(),
    received: z.number().int(),
    percent: z
      .number()
      .nullable()
      .describe('received/expected as a percentage, one decimal. NULL when nothing was due.'),
    netVariance: z.number().int().describe('Negative means collectors were short overall'),
    daysReconciled: z.number().int(),
    daysWithVariance: z.number().int(),
  })
  .meta({ id: 'CollectionEfficiency' });

const dashboardAlert = z
  .object({
    key: z.string().describe('Stable identifier — key UI off this, not the title'),
    severity: z.enum(['info', 'warning', 'critical']),
    title: z.string(),
    body: z.string().describe('One sentence stating the condition, phrased for display'),
    count: z.number().int(),
    amount: z
      .number()
      .int()
      .nullable()
      .describe('Money at stake in pesewas, or null when the alert is not about an amount'),
    target: z
      .object({ module: z.string(), filter: z.record(z.string(), z.string()) })
      .describe('Where the work lives, so the action button can route without a hardcoded map'),
  })
  .meta({ id: 'DashboardAlert' });

export const dashboardPaths: ZodOpenApiPathsObject = {
  '/dashboard/summary': {
    get: {
      tags,
      summary: 'Headline KPIs, today’s cash, month revenue, and the live portfolio position',
      description:
        'Everything the dashboard tiles and the portfolio breakdown need, computed fresh ' +
        'on every call. `kpis` maps one-to-one onto the headline tiles; `today`, ' +
        '`monthToDate` and `portfolio` carry the detail behind them.\n\n' +
        'All amounts are integer pesewas. Socket.io money events to the admin room ' +
        'signal WHEN to refetch — this endpoint is always the source of truth.\n\n' +
        'Replaces `GET /reports/dashboard`, which remains as a deprecated alias.',
      security,
      responses: { '200': jsonResponse('Dashboard summary', dashboardSummary) },
    },
  },
  '/dashboard/series': {
    get: {
      tags,
      summary: 'Cash in/out and collector handovers bucketed over time',
      description:
        'One series powering the cash-flow, collections-performance and reconciliation ' +
        'charts. Every bucket in the range is returned, including empty ones — a chart ' +
        'that skips an empty month draws a slope across it and implies activity that ' +
        'never happened.\n\n' +
        '`from`/`to` are optional; omitting them gives a sensible span for the bucket ' +
        'size (30 days, 12 weeks, or 12 months). `expected`/`received` come from ' +
        'RECONCILED collector days only, so the newest buckets legitimately read as zero ' +
        'until the office confirms those handovers.',
      security,
      requestParams: {
        query: z.object({
          from: z.string().optional(),
          to: z.string().optional(),
          bucket: z.enum(['day', 'week', 'month']).optional(),
        }),
      },
      responses: {
        '200': jsonResponse('Bucketed cash series', cashSeries),
        '400': errorResponse('from is after to'),
      },
    },
  },
  '/dashboard/efficiency': {
    get: {
      tags,
      summary: 'Cash-handover accuracy: how much of the recorded field cash reached the office',
      description:
        'Of the field cash the system recorded collectors taking in, how much the office ' +
        'confirmed receiving, over the range (default: last 30 days).\n\n' +
        '**This measures whether money reached the office, not whether customers paid ' +
        'what they owed.** Loans and hire purchase are collected at the office and never ' +
        'appear here — only susu and savings cash does.',
      security,
      requestParams: {
        query: z.object({ from: z.string().optional(), to: z.string().optional() }),
      },
      responses: {
        '200': jsonResponse('Collection efficiency', collectionEfficiency),
        '400': errorResponse('from is after to'),
      },
    },
  },
  '/dashboard/alerts': {
    get: {
      tags,
      summary: 'Standing business conditions that need someone to act',
      description:
        'Aggregates over live state — susu payouts waiting, loans and HP in arrears, ' +
        'applications awaiting a decision, unconfirmed cash handovers, and mobile money ' +
        'taken but not applied.\n\n' +
        'Deliberately NOT the notifications collection: a notification is one past event ' +
        'addressed to one staff member, an alert is a condition that stays true until the ' +
        'work is done and is the same for everyone in the office. Alerts with nothing ' +
        'behind them are omitted, so an empty array means nothing needs attention. ' +
        'Sorted critical → warning → info.',
      security,
      responses: {
        '200': jsonResponse(
          'Active alerts',
          z.object({ alerts: z.array(dashboardAlert), generatedAt: z.iso.datetime() }),
        ),
      },
    },
  },
  '/dashboard/recent-transactions': {
    get: {
      tags,
      summary: 'The last few money events, for the dashboard activity panel',
      description:
        'A short window onto the unified transaction feed over the last 30 days. Deeper ' +
        'filtering, paging and CSV/XLSX export belong on `GET /reports/transactions`.\n\n' +
        'Unapplied Paystack charges are included by default (`includePending=true`) so the ' +
        'panel can show money that is still in flight — those rows carry ' +
        '`status: "pending"` (or `"failed"` when Paystack took the money but it could not ' +
        'be posted) and are EXCLUDED from `totals`, which only ever counts money that ' +
        'actually moved.',
      security,
      requestParams: {
        query: z.object({
          limit: z.string().optional(),
          includePending: z.enum(['true', 'false']).optional(),
        }),
      },
      responses: {
        '200': jsonResponse(
          'Recent transactions',
          z.object({ items: z.array(unifiedTransaction), totals: txnTotals }),
        ),
      },
    },
  },
};
