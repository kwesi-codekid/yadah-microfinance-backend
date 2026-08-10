import { Router } from 'express';
import { sendExport } from '../../lib/exports.js';
import { workerStatuses } from '../../lib/worker-status.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOffice, requireRole } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  formatOnlyQuery,
  rangeQuery,
  transactionsQuery,
  type FormatOnlyQuery,
  type RangeQuery,
  type TransactionsQuery,
} from './reports.schemas.js';
import * as reportsService from './reports.service.js';
import * as transactionsService from './transactions.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireOffice);

// Ops visibility: background-worker heartbeats (admin only; in-memory,
// resets on restart — every worker also runs immediately at startup).
reportsRouter.get('/workers', requireRole('admin'), (_req, res) => {
  res.json({ workers: workerStatuses() });
});

reportsRouter.get('/transactions', validate({ query: transactionsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: TransactionsQuery }>(req);
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

reportsRouter.get('/loans/outstanding', validate({ query: formatOnlyQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: FormatOnlyQuery }>(req);
  reportsService
    .outstandingLoans()
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

reportsRouter.get('/loans/aging', validate({ query: formatOnlyQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: FormatOnlyQuery }>(req);
  reportsService
    .arrearsAging()
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
          { source: 'total', count: '', amount: report.totalRevenue },
        ],
        moneyKeys: ['amount'],
        sheet: 'Commission',
      }),
    )
    .catch(next);
});
