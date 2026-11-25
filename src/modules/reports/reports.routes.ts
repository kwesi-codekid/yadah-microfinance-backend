import { Router } from 'express';
import { Types } from 'mongoose';
import { sendExport } from '../../lib/exports.js';
import { workerStatuses } from '../../lib/worker-status.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice, requireRole } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  rangeQuery,
  transactionsQuery,
  type RangeQuery,
  type TransactionsQuery,
} from './reports.schemas.js';
import * as dashboardService from '../dashboard/dashboard.service.js';
import * as reportsService from './reports.service.js';
import { enteredForCollectors } from './entered-for.service.js';
import { OVERVIEW_PERIODS, reportsOverview, type OverviewPeriod } from './overview.service.js';
import * as transactionsService from './transactions.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth);

// The ledger, open to every role. Registered BEFORE the office gate below,
// which is what opens it to tellers and collectors; the service narrows them
// to the entries they recorded themselves, so each sees their own day — what
// they took in and what they issued out — and never anyone else's.
reportsRouter.get('/transactions', validate({ query: transactionsQuery }), (req, res, next) => {
  const { query: asked } = getValidated<{ query: TransactionsQuery }>(req);
  const query = transactionsService.scopeTransactionsQuery(getAuth(req), asked);
  if (query.format !== 'json') {
    transactionsService
      .transactionsCsvRows(query)
      .then((rows) =>
        sendExport(res, {
          format: query.format,
          filename: 'transactions',
          payload: null,
          rows,
          moneyKeys: ['amount', 'fee', 'balanceAfter'],
          sheet: 'Transactions',
        }),
      )
      .catch(next);
    return;
  }
  transactionsService
    .listTransactions(query)
    .then((feed) => res.json(feed))
    .catch(next);
});

// What a member of staff typed in for collectors, collector by collector — the
// other half of the attendant's end of day, beside their own ledger above.
// Open like the ledger and scoped the same way: the office may name anyone
// (`recordedById`), everybody else is answered for themselves.
reportsRouter.get(
  '/transactions/entered-for',
  validate({ query: transactionsQuery }),
  (req, res, next) => {
    const { query: asked } = getValidated<{ query: TransactionsQuery }>(req);
    const actor = getAuth(req);
    const office = actor.role === 'admin' || actor.role === 'manager';
    const staffId =
      office && asked.recordedById ? asked.recordedById : new Types.ObjectId(actor.sub);
    enteredForCollectors(staffId, asked.from, asked.to)
      .then((report) => res.json(report))
      .catch(next);
  },
);

// Everything from here down is office only.
reportsRouter.use(requireOffice);

// Ops visibility: background-worker heartbeats (admin only; in-memory,
// resets on restart — every worker also runs immediately at startup).
reportsRouter.get('/workers', requireRole('admin'), (_req, res) => {
  res.json({ workers: workerStatuses() });
});

// Deprecated alias for GET /dashboard/summary, kept so anything already wired
// to this path keeps working. New callers should use the dashboard group.
reportsRouter.get('/dashboard', (_req, res, next) => {
  dashboardService
    .dashboardMetrics()
    .then((metrics) => res.json(metrics))
    .catch(next);
});

// The Reports page: every book over a period, read from the books themselves.
reportsRouter.get('/overview', (req, res, next) => {
  const raw = typeof req.query.period === 'string' ? req.query.period : 'quarter';
  const period: OverviewPeriod = raw in OVERVIEW_PERIODS ? (raw as OverviewPeriod) : 'quarter';
  reportsOverview(period)
    .then((report) => res.json(report))
    .catch(next);
});

reportsRouter.get('/collections', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .collectionsByStaff(query.from, query.to)
    .then((report) =>
      sendExport(res, {
        format: query.format,
        filename: `collections-${report.from}-to-${report.to}`,
        payload: report,
        rows: report.rows,
        moneyKeys: ['susuAmount', 'savingsAmount', 'totalAmount'],
        sheet: 'Collections by staff',
      }),
    )
    .catch(next);
});

reportsRouter.get('/loans/outstanding', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .outstandingLoans(query.from, query.to)
    .then((report) =>
      sendExport(res, {
        format: query.format,
        filename: 'outstanding-loans',
        payload: report,
        rows: report.rows,
        moneyKeys: ['principal', 'totalDue', 'totalRepaid', 'remaining'],
        sheet: 'Outstanding loans',
      }),
    )
    .catch(next);
});

reportsRouter.get('/loans/aging', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .arrearsAging(query.from, query.to)
    .then((report) =>
      sendExport(res, {
        format: query.format,
        filename: 'arrears-aging',
        payload: report,
        rows: report.rows,
        moneyKeys: ['principal', 'totalDue', 'totalRepaid', 'remaining'],
        sheet: 'Arrears aging',
      }),
    )
    .catch(next);
});

reportsRouter.get('/commission', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .commissionEarned(query.from, query.to)
    .then((report) =>
      sendExport(res, {
        format: query.format,
        filename: `commission-${report.from}-to-${report.to}`,
        payload: report,
        rows: [
          {
            source: 'susu-commission',
            count: report.susuCommission.count,
            amount: report.susuCommission.amount,
          },
          {
            source: 'savings-fees',
            count: report.savingsFees.count,
            amount: report.savingsFees.amount,
          },
          {
            source: 'outright-sales-margin',
            count: report.outrightSalesProfit.count,
            amount: report.outrightSalesProfit.amount,
          },
          { source: 'total', count: '', amount: report.totalRevenue },
        ],
        moneyKeys: ['amount'],
        sheet: 'Commission',
      }),
    )
    .catch(next);
});
