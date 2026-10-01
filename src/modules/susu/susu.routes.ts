import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireAdmin, requireCounter, requireOffice } from '../../middleware/rbac.js';
import { runSusuMigration } from './susu.migration.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { trashBody, type TrashBody } from '../../schemas/common.js';
import {
  accountIdParams,
  addPlanBody,
  changePlanBody,
  depositBody,
  depositIdParams,
  listAccountsQuery,
  listCyclesQuery,
  listPayoutsQuery,
  migrateBody,
  listDepositsQuery,
  listTrashQuery,
  openAccountBody,
  payoutIdParams,
  planIdParams,
  summaryQuery,
  updateDepositBody,
  withdrawalBody,
  type AccountIdParams,
  type AddPlanBody,
  type ChangePlanBody,
  type DepositBody,
  type DepositIdParams,
  type ListAccountsQuery,
  type ListCyclesQuery,
  type ListPayoutsQuery,
  type MigrateBody,
  type ListDepositsQuery,
  type ListTrashQuery,
  type OpenAccountBody,
  type PayoutIdParams,
  type PlanIdParams,
  type SummaryQuery,
  type UpdateDepositBody,
  type WithdrawalBody,
} from './susu.schemas.js';
import {
  proposeCorrectionBody,
  type ProposeCorrectionBody,
} from '../corrections/corrections.schemas.js';
import * as corrections from '../corrections/corrections.service.js';
import * as susuService from './susu.service.js';

export const susuRouter = Router();
susuRouter.use(requireAuth);

// Opened where the customer is standing, so the counter opens it.
susuRouter.post(
  '/accounts',
  requireCounter,
  validate({ body: openAccountBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: OpenAccountBody }>(req);
    susuService
      .openAccount(getAuth(req), body.customerId, body.dailyAmount, req.id as string)
      .then((result) => res.status(result.reopened ? 200 : 201).json(result))
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
          moneyKeys: ['balance', 'locked', 'availableToWithdraw', 'dailyTotal'],
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

// ---------------------------------------------------------------- plans

susuRouter.post(
  '/accounts/:id/plans',
  requireCounter,
  validate({ params: accountIdParams, body: addPlanBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: AddPlanBody }>(req);
    susuService
      .addPlan(getAuth(req), params.id, body.dailyAmount, req.id as string)
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);

susuRouter.patch(
  '/accounts/:id/plans/:planId',
  requireCounter,
  validate({ params: planIdParams, body: changePlanBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: PlanIdParams; body: ChangePlanBody }>(req);
    susuService
      .changePlanAmount(getAuth(req), params.id, params.planId, body.dailyAmount, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

susuRouter.post(
  '/accounts/:id/plans/:planId/stop',
  requireCounter,
  validate({ params: planIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: PlanIdParams }>(req);
    susuService
      .stopPlan(getAuth(req), params.id, params.planId, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

susuRouter.get(
  '/accounts/:id/cycles',
  validate({ params: accountIdParams, query: listCyclesQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListCyclesQuery }>(
      req,
    );
    susuService
      .listAccountCycles(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

susuRouter.get(
  '/accounts/:id/payouts',
  validate({ params: accountIdParams, query: listPayoutsQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListPayoutsQuery }>(
      req,
    );
    susuService
      .listAccountPayouts(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

// ---------------------------------------------------------------- deposits

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
            moneyKeys: ['amount', 'leftover', 'commissionAmount'],
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

// Correct the most recent deposit's amount. Office only: a figure already on
// the ledger is changed by a decision. The counter's door is the request
// below, which the office applies through this same correction.
susuRouter.patch(
  '/accounts/:id/deposits/:depositId',
  requireOffice,
  validate({ params: depositIdParams, body: updateDepositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: DepositIdParams; body: UpdateDepositBody }>(
      req,
    );
    susuService
      .updateDeposit(
        getAuth(req),
        params.id,
        params.depositId,
        body.amount,
        req.id as string,
        body.split?.map((s) => ({ planId: s.planId.toHexString(), payments: s.payments })),
      )
      .then((result) => res.json(result))
      .catch(next);
  },
);

// A teller may not correct a deposit, but may ask the office to. Refused on
// the spot for anything the correction itself would refuse; decided under
// /corrections, which runs the same correction as the PATCH above.
susuRouter.post(
  '/accounts/:id/deposits/:depositId/corrections',
  requireCounter,
  validate({ params: depositIdParams, body: proposeCorrectionBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: DepositIdParams;
      body: ProposeCorrectionBody;
    }>(req);
    corrections
      .propose(getAuth(req), 'susu-deposit', params.id, params.depositId, body, req.id as string)
      .then((correction) => res.status(201).json({ correction }))
      .catch(next);
  },
);

// Trash the most recent deposit — un-credits the plans and the balance atomically.
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
        body.occurredOn,
        body.split?.map((s) => ({ planId: s.planId.toHexString(), payments: s.payments })),
      )
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

// Money out across the counter — a teller's job (client decision, 10 Sep 2026).
susuRouter.post(
  '/accounts/:id/withdraw',
  requireCounter,
  validate({ params: accountIdParams, body: withdrawalBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: WithdrawalBody }>(req);
    susuService
      .withdraw(getAuth(req), params.id, body.amount, body.idempotencyKey, req.id as string)
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

susuRouter.post(
  '/accounts/:id/close',
  requireCounter,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    susuService
      .closeAccount(getAuth(req), params.id, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Trash: only empty, unused accounts — used accounts go through close.
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

// Printable receipts. Not office-only: a collector who took the cash in the
// field must be able to hand over a receipt for it.
susuRouter.get(
  '/accounts/:id/deposits/:depositId/receipt',
  validate({ params: depositIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: DepositIdParams }>(req);
    susuService
      .depositReceipt(getAuth(req), params.id, params.depositId)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);

susuRouter.get(
  '/accounts/:id/withdrawals/:payoutId/receipt',
  validate({ params: payoutIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: PayoutIdParams }>(req);
    susuService
      .withdrawalReceipt(getAuth(req), params.id, params.payoutId)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
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

// The susu data update, from the office's screen. Admin only: it rewrites the ledger.
susuRouter.post('/migrate', requireAdmin, validate({ body: migrateBody }), (req, res, next) => {
  const { body } = getValidated<{ body: MigrateBody }>(req);
  runSusuMigration(getAuth(req), body.apply, req.id as string)
    .then((report) => res.json(report))
    .catch(next);
});
