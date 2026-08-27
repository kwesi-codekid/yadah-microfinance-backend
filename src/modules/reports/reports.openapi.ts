import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { TXN_MODULES, TXN_STATUSES, TXN_TYPES } from '../../domain/transactions.js';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import { formatOnlyQuery, rangeQuery, transactionsQuery } from './reports.schemas.js';

const security = [{ bearerAuth: [] }];
const csvNote = ' Pass format=csv for a downloadable CSV.';

export const unifiedTransaction = z
  .object({
    id: z.string(),
    module: z.enum(TXN_MODULES),
    type: z.enum(TXN_TYPES),
    direction: z
      .enum(['in', 'out', 'internal'])
      .describe(
        "From the company's cash perspective. 'internal' rows are transfer legs " +
          '(money moved between the same customer’s products) — excluded from cash totals.',
      ),
    amount: z.number().int().describe('Integer pesewas'),
    fee: z.number().int().describe('Integer pesewas (savings withdrawal / transfer fee)'),
    status: z
      .enum(TXN_STATUSES)
      .describe(
        "'completed' for every ledger row — the modules only write once money has moved. " +
          "'pending' and 'failed' appear only when includePending=true, and only for " +
          'Paystack charges not yet applied: pending is awaiting confirmation, failed is ' +
          'money Paystack took that could not be posted. Neither is counted in totals.',
      ),
    channel: z.string().nullable(),
    detail: z
      .string()
      .nullable()
      .describe('Payout destination, repayment source, or transfer route (e.g. susu->loan)'),
    customerId: z.string(),
    customerName: z.string(),
    ref: z.object({
      kind: z.enum([
        'susu-account',
        'savings-account',
        'loan',
        'hp-agreement',
        'hp-sale',
        'transfer',
      ]),
      id: z.string(),
      accountNumber: z
        .string()
        .optional()
        .describe(
          'PREFIX + YY + MM + 4-digit monthly sequence, e.g. SU26080001 (SU susu, ' +
            'SV savings, LN loan, HP hire purchase). Susu and savings accounts opened ' +
            'before this scheme keep their legacy all-digit numbers (6 and 10 digits). ' +
            'Absent on outright sales and transfers, which are not accounts.',
        ),
    }),
    balanceAfter: z.number().int().optional().describe('Savings rows only: running balance'),
    recordedById: z.string().nullable(),
    recordedByName: z.string().nullable().describe("'System' for automated debt-recovery moves"),
    createdAt: z.iso.datetime(),
  })
  .meta({ id: 'UnifiedTransaction' });

export const txnTotals = z
  .object({
    in: z.object({ count: z.number().int(), amount: z.number().int() }),
    out: z.object({ count: z.number().int(), amount: z.number().int() }),
    internal: z.object({ count: z.number().int(), amount: z.number().int() }),
    feesCollected: z.number().int().describe('Savings withdrawal/closure fees in the range'),
  })
  .meta({ id: 'TransactionTotals' });

const transactionsFeed = z.object({
  from: z.string(),
  to: z.string(),
  items: z.array(unifiedTransaction),
  page: z.number().int(),
  limit: z.number().int(),
  total: z.number().int().describe('Total rows matching the filters (all pages)'),
  totals: txnTotals.describe('Totals over the WHOLE filtered range, not just this page'),
});

const countAmount = z.object({ count: z.number().int(), amount: z.number().int() });

const dashboardMetrics = z
  .object({
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
        valueHeld: z.number().int(),
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
  .meta({ id: 'DashboardMetrics' });

export const reportPaths: ZodOpenApiPathsObject = {
  '/reports/dashboard': {
    get: {
      tags: ['Reports'],
      deprecated: true,
      summary: 'DEPRECATED — use GET /dashboard/summary',
      description:
        'Kept so existing callers keep working. `GET /dashboard/summary` returns this ' +
        'payload plus the headline `kpis` block and yesterday’s comparison figure.\n\n' +
        "Today's cash in/out by source (internal transfers excluded), month-to-date " +
        'revenue (susu commission + savings fees + outright-sale margin), and the ' +
        'live portfolio position ' +
        '(accounts, balances, outstanding loans/HP). All amounts are integer pesewas. ' +
        'Socket.io money events to the admin room signal WHEN to refetch — this ' +
        'endpoint is always the source of truth. JSON only.',
      security,
      responses: { '200': jsonResponse('Dashboard metrics', dashboardMetrics) },
    },
  },
  '/reports/transactions': {
    get: {
      tags: ['Reports'],
      summary: 'Unified transaction feed across every module',
      description:
        'Every money event — susu deposits/payouts, savings transactions, loan ' +
        'disbursements/repayments, hire purchase payments, and transfers — as one ' +
        'paginated list, newest first, filtered to an inclusive Accra-day range ' +
        '(defaults to the last 30 days). Optional module and customerId filters. ' +
        'A transfer appears as its per-module legs plus the transfer row itself, all ' +
        'marked direction=internal, so totals count only real cash movement. CSV ' +
        'export ignores pagination and is capped at 10,000 rows.\n\n' +
        'Set `includePending=true` to also show Paystack charges that have not been ' +
        'applied yet — money still in flight. Those rows carry `status: "pending"` (or ' +
        '`"failed"` when Paystack took the money but it could not be posted) and are ' +
        'never counted in `totals`.' +
        csvNote,
      security,
      requestParams: { query: transactionsQuery },
      responses: { '200': jsonResponse('Transaction feed', transactionsFeed) },
    },
  },
  '/reports/collections': {
    get: {
      tags: ['Reports'],
      summary: 'Collections by staff member over a date range',
      description:
        'Susu and savings deposits recorded per user (reconciliation: who brought in what). ' +
        'Defaults to the last 30 Accra days.' +
        csvNote,
      security,
      requestParams: { query: rangeQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/loans/outstanding': {
    get: {
      tags: ['Reports'],
      summary: 'All open loans with remaining balances and days overdue',
      description: 'Active and arrears loans, soonest due first.' + csvNote,
      security,
      requestParams: { query: formatOnlyQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/loans/aging': {
    get: {
      tags: ['Reports'],
      summary: 'Arrears aging buckets (1–30 / 31–90 / 90+ days)',
      security,
      requestParams: { query: formatOnlyQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/commission': {
    get: {
      tags: ['Reports'],
      summary: 'Revenue earned: susu commissions + savings fees + outright-sale margin',
      description:
        'Susu closure commissions, savings withdrawal/closure fees, and the margin on ' +
        'outright counter sales (selling price less cost, voided sales excluded) in the ' +
        'range. The sale margin is trading profit rather than a fee, but it is real money ' +
        'earned in the period, so it counts toward totalRevenue.' +
        csvNote,
      security,
      requestParams: { query: rangeQuery },
      responses: { '200': jsonResponse('Report', z.unknown()) },
    },
  },
  '/reports/workers': {
    get: {
      tags: ['Reports'],
      summary: 'Background-worker heartbeats (admin only)',
      description:
        'Last run, outcome and change counters for the SMS, loan-escalation, ' +
        'HP-arrears and debt-recovery workers. In-memory — resets on restart; ' +
        'each worker also runs a pass immediately at startup.',
      security,
      responses: {
        '200': jsonResponse(
          'Worker statuses keyed by name',
          z.object({
            workers: z.record(
              z.string(),
              z.object({
                startedAt: z.iso.datetime().nullable(),
                lastRunAt: z.iso.datetime().nullable(),
                lastOk: z.boolean().nullable(),
                lastError: z.string().nullable(),
                lastChanges: z.record(z.string(), z.number()).nullable(),
                runCount: z.number().int(),
              }),
            ),
          }),
        ),
        '403': errorResponse('FORBIDDEN — admin only'),
      },
    },
  },
};
