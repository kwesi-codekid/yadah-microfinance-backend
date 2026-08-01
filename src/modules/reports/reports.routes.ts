import { Router, type Response } from 'express';
import { toCsv } from '../../lib/csv.js';
import { requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  formatOnlyQuery,
  rangeQuery,
  type FormatOnlyQuery,
  type RangeQuery,
} from './reports.schemas.js';
import * as reportsService from './reports.service.js';

export const reportsRouter = Router();
reportsRouter.use(requireAuth, requireOffice);

function send(
  res: Response,
  format: 'json' | 'csv',
  filename: string,
  payload: unknown,
  csvRows: readonly object[],
): void {
  if (format === 'csv') {
    res.type('text/csv').attachment(`${filename}.csv`).send(toCsv(csvRows));
  } else {
    res.json(payload);
  }
}

reportsRouter.get('/collections', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .collectionsByStaff(query.from, query.to)
    .then((report) => {
      send(res, query.format, `collections-${report.from}-to-${report.to}`, report, report.rows);
    })
    .catch(next);
});

reportsRouter.get('/loans/outstanding', validate({ query: formatOnlyQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: FormatOnlyQuery }>(req);
  reportsService
    .outstandingLoans()
    .then((report) => {
      send(res, query.format, 'outstanding-loans', report, report.rows);
    })
    .catch(next);
});

reportsRouter.get('/loans/aging', validate({ query: formatOnlyQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: FormatOnlyQuery }>(req);
  reportsService
    .arrearsAging()
    .then((report) => {
      send(res, query.format, 'arrears-aging', report, report.rows);
    })
    .catch(next);
});

reportsRouter.get('/commission', validate({ query: rangeQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: RangeQuery }>(req);
  reportsService
    .commissionEarned(query.from, query.to)
    .then((report) => {
      send(res, query.format, `commission-${report.from}-to-${report.to}`, report, [
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
      ]);
    })
    .catch(next);
});
