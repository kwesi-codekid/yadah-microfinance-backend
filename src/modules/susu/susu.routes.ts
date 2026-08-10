import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { trashBody, type TrashBody } from '../../schemas/common.js';
import {
  accountIdParams,
  collectAllBody,
  depositBody,
  depositIdParams,
  listAccountsQuery,
  listDepositsQuery,
  listTrashQuery,
  openAccountBody,
  payoutBody,
  summaryQuery,
  updateDepositBody,
  type AccountIdParams,
  type CollectAllBody,
  type DepositBody,
  type DepositIdParams,
  type ListAccountsQuery,
  type ListDepositsQuery,
  type ListTrashQuery,
  type OpenAccountBody,
  type PayoutBody,
  type SummaryQuery,
  type UpdateDepositBody,
} from './susu.schemas.js';
import * as susuService from './susu.service.js';

export const susuRouter = Router();
susuRouter.use(requireAuth);

susuRouter.post(
  '/accounts',
  requireOffice,
  validate({ body: openAccountBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: OpenAccountBody }>(req);
    susuService
      .openAccount(getAuth(req), body.customerId, body.dailyAmount, req.id as string)
      .then((account) => res.status(201).json({ account }))
      .catch(next);
  },
);

susuRouter.get('/accounts', validate({ query: listAccountsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListAccountsQuery }>(req);
  if (query.format !== 'json') {
    // Exports skip pagination — capped by EXPORT_MAX_ROWS instead of the zod limit.
    susuService
      .listAccounts(getAuth(req), { ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'susu-accounts',
          payload: null,
          rows: list.items.map(susuService.toSusuAccountExportRow),
          moneyKeys: [
            'dailyAmount',
            'totalDeposited',
            'commissionAmount',
            'payoutAmount',
            'payoutRemaining',
          ],
          sheet: 'Susu accounts',
        }),
      )
      .catch(next);
    return;
  }
  susuService
    .listAccounts(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

// Registered BEFORE /accounts/:id so 'trash' is not captured as an id.
susuRouter.get(
  '/accounts/trash',
  requireOffice,
  validate({ query: listTrashQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: ListTrashQuery }>(req);
    susuService
      .listSusuAccountTrash(getAuth(req), query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

susuRouter.get('/accounts/:id', validate({ params: accountIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: AccountIdParams }>(req);
  susuService
    .getAccount(getAuth(req), params.id)
    .then((account) => res.json({ account }))
    .catch(next);
});

susuRouter.get(
  '/accounts/:id/deposits',
  validate({ params: accountIdParams, query: listDepositsQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListDepositsQuery }>(
      req,
    );
    if (query.format !== 'json') {
      // Exports skip pagination — capped by EXPORT_MAX_ROWS instead of the zod limit.
      susuService
        .listAccountDeposits(getAuth(req), params.id, { ...query, page: 1, limit: EXPORT_MAX_ROWS })
        .then((list) =>
          sendExport(res, {
            format: query.format,
            filename: 'susu-deposits',
            payload: null,
            rows: list.items.map(susuService.toSusuDepositExportRow),
            moneyKeys: ['amount'],
            sheet: 'Susu deposits',
          }),
        )
        .catch(next);
      return;
    }
    susuService
      .listAccountDeposits(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

// Trashed deposits of one account (office only).
susuRouter.get(
  '/accounts/:id/deposits/trash',
  requireOffice,
  validate({ params: accountIdParams, query: listTrashQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListTrashQuery }>(req);
    susuService
      .listDepositTrash(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

// Correct the most recent deposit's amount (office only).
susuRouter.patch(
  '/accounts/:id/deposits/:depositId',
  requireOffice,
  validate({ params: depositIdParams, body: updateDepositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: DepositIdParams; body: UpdateDepositBody }>(
      req,
    );
    susuService
      .updateDeposit(getAuth(req), params.id, params.depositId, body.amount, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Trash the most recent deposit — reverses the account counters atomically.
susuRouter.delete(
  '/accounts/:id/deposits/:depositId',
  requireOffice,
  validate({ params: depositIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: DepositIdParams; body: TrashBody }>(req);
    susuService
      .trashDeposit(getAuth(req), params.id, params.depositId, body.reason, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

susuRouter.post(
  '/accounts/:id/deposits/:depositId/restore',
  requireOffice,
  validate({ params: depositIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: DepositIdParams }>(req);
    susuService
      .restoreDeposit(getAuth(req), params.id, params.depositId, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Any collector or office staff records deposits.
susuRouter.post(
  '/accounts/:id/deposits',
  validate({ params: accountIdParams, body: depositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: DepositBody }>(req);
    susuService
      .recordDeposit(
        getAuth(req),
        params.id,
        body.amount,
        body.idempotencyKey,
        body.channel,
        req.id as string,
      )
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

susuRouter.post('/collect-all', validate({ body: collectAllBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CollectAllBody }>(req);
  susuService
    .collectAll(
      getAuth(req),
      body.customerId,
      body.amount,
      body.idempotencyKey,
      body.channel,
      req.id as string,
    )
    .then((result) => res.status(result.replayed ? 200 : 201).json(result))
    .catch(next);
});

// Withdrawals are processed at the office only (rule 7).
susuRouter.post(
  '/accounts/:id/close',
  requireOffice,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    susuService
      .closeAccount(getAuth(req), params.id, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Escape hatch for accounts that cannot cover the commission (office only).
susuRouter.post(
  '/accounts/:id/terminate',
  requireOffice,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    susuService
      .terminateAccount(getAuth(req), params.id, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Trash: only empty, unused accounts — used accounts go through close/terminate.
susuRouter.delete(
  '/accounts/:id',
  requireOffice,
  validate({ params: accountIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: TrashBody }>(req);
    susuService
      .trashSusuAccount(getAuth(req), params.id, body.reason, req.id as string)
      .then((account) => res.json({ account }))
      .catch(next);
  },
);

susuRouter.post(
  '/accounts/:id/restore',
  requireOffice,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    susuService
      .restoreSusuAccount(getAuth(req), params.id, req.id as string)
      .then((account) => res.json({ account }))
      .catch(next);
  },
);

// Cash disbursement of a pending-payout balance (office only).
susuRouter.post(
  '/accounts/:id/payout',
  requireOffice,
  validate({ params: accountIdParams, body: payoutBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: PayoutBody }>(req);
    susuService
      .payoutPending(getAuth(req), params.id, body.amount, body.idempotencyKey, req.id as string)
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

susuRouter.get('/summary', validate({ query: summaryQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: SummaryQuery }>(req);
  susuService
    .dailySummary(getAuth(req), query)
    .then((summary) => res.json(summary))
    .catch(next);
});
