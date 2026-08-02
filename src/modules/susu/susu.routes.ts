import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  accountIdParams,
  collectAllBody,
  depositBody,
  listAccountsQuery,
  listDepositsQuery,
  openAccountBody,
  payoutBody,
  summaryQuery,
  type AccountIdParams,
  type CollectAllBody,
  type DepositBody,
  type ListAccountsQuery,
  type ListDepositsQuery,
  type OpenAccountBody,
  type PayoutBody,
  type SummaryQuery,
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
  susuService
    .listAccounts(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

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
    susuService
      .listAccountDeposits(getAuth(req), params.id, query)
      .then((list) => res.json(list))
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
        body.daysCovered,
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
