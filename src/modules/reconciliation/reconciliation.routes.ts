import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  confirmDayBody,
  declareDayBody,
  expectedQuery,
  listReconciliationsQuery,
  reconciliationIdParams,
  varianceReportQuery,
  type ConfirmDayBody,
  type DeclareDayBody,
  type ExpectedQuery,
  type ListReconciliationsQuery,
  type ReconciliationIdParams,
  type VarianceReportQuery,
} from './reconciliation.schemas.js';
import * as service from './reconciliation.service.js';

export const reconciliationRouter = Router();
reconciliationRouter.use(requireAuth);

// What the system says was collected — the collector's cross-check before
// they count. Registered before /:id so 'expected' is never read as an id.
reconciliationRouter.get('/expected', validate({ query: expectedQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ExpectedQuery }>(req);
  service
    .previewExpected(getAuth(req), query.accraDay, query.collectorId)
    .then((expected) => res.json(expected))
    .catch(next);
});

// Who is short, how often, by how much (office only).
reconciliationRouter.get(
  '/variances',
  requireOffice,
  validate({ query: varianceReportQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: VarianceReportQuery }>(req);
    service
      .varianceReport(query)
      .then((report) => {
        if (query.format !== 'json') {
          return sendExport(res, {
            format: query.format,
            filename: 'cash-variances',
            payload: null,
            rows: report.rows.map(service.toVarianceExportRow),
            moneyKeys: ['totalExpected', 'totalReceived', 'netVariance', 'totalShort', 'totalOver'],
            sheet: 'Variances',
          });
        }
        res.json(report);
        return undefined;
      })
      .catch(next);
  },
);

// Step 1 — the collector closes their round with the cash they counted.
reconciliationRouter.post('/declare', validate({ body: declareDayBody }), (req, res, next) => {
  const { body } = getValidated<{ body: DeclareDayBody }>(req);
  service
    .declareDay(getAuth(req), body, req.id as string)
    .then((result) => res.status(201).json({ reconciliation: result }))
    .catch(next);
});

reconciliationRouter.get('/', validate({ query: listReconciliationsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListReconciliationsQuery }>(req);
  if (query.format !== 'json') {
    service
      .listReconciliations(getAuth(req), { ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'reconciliations',
          payload: null,
          rows: list.items.map(service.toReconciliationExportRow),
          moneyKeys: [
            'expectedAmount',
            'expectedSusu',
            'expectedSavings',
            'declaredAmount',
            'receivedAmount',
            'variance',
            'declaredVsReceived',
          ],
          sheet: 'Reconciliations',
        }),
      )
      .catch(next);
    return;
  }
  service
    .listReconciliations(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

reconciliationRouter.get('/:id', validate({ params: reconciliationIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: ReconciliationIdParams }>(req);
  service
    .getReconciliation(getAuth(req), params.id)
    .then((reconciliation) => res.json({ reconciliation }))
    .catch(next);
});

/**
 * Step 2 — whoever the cash was handed to counts it in.
 *
 * The gate is the counter, not the office, because a collector hands their day
 * to a teller. Which days a teller may count in is narrowed in the service:
 * collectors' only, never another teller's and never their own.
 */
reconciliationRouter.post(
  '/:id/confirm',
  requireCounter,
  validate({ params: reconciliationIdParams, body: confirmDayBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: ReconciliationIdParams;
      body: ConfirmDayBody;
    }>(req);
    service
      .confirmDay(getAuth(req), params.id, body, req.id as string)
      .then((reconciliation) => res.json({ reconciliation }))
      .catch(next);
  },
);
