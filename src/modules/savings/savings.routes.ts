import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  accountIdParams,
  depositBody,
  listAccountsQuery,
  listTxnsQuery,
  openAccountBody,
  withdrawalBody,
  type AccountIdParams,
  type DepositBody,
  type ListAccountsQuery,
  type ListTxnsQuery,
  type OpenAccountBody,
  type WithdrawalBody,
} from './savings.schemas.js';
import * as savingsService from './savings.service.js';

export const savingsRouter = Router();
savingsRouter.use(requireAuth);

savingsRouter.post(
  '/accounts',
  requireOffice,
  validate({ body: openAccountBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: OpenAccountBody }>(req);
    savingsService
      .openAccount(
        getAuth(req),
        body.customerId,
        body.initialDeposit,
        body.idempotencyKey,
        body.channel,
        req.id as string,
      )
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);

savingsRouter.get('/accounts', validate({ query: listAccountsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListAccountsQuery }>(req);
  savingsService
    .listAccounts(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

savingsRouter.get('/accounts/:id', validate({ params: accountIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: AccountIdParams }>(req);
  savingsService
    .getAccount(getAuth(req), params.id)
    .then((account) => res.json({ account }))
    .catch(next);
});

savingsRouter.get(
  '/accounts/:id/transactions',
  validate({ params: accountIdParams, query: listTxnsQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListTxnsQuery }>(req);
    savingsService
      .listTransactions(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

// Collectors (own customers) and office staff both record deposits.
savingsRouter.post(
  '/accounts/:id/deposits',
  validate({ params: accountIdParams, body: depositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: DepositBody }>(req);
    savingsService
      .deposit(
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

// Withdrawals are processed at the office only.
savingsRouter.post(
  '/accounts/:id/withdrawals',
  requireOffice,
  validate({ params: accountIdParams, body: withdrawalBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: WithdrawalBody }>(req);
    savingsService
      .withdraw(getAuth(req), params.id, body.amount, body.idempotencyKey, req.id as string)
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

savingsRouter.post(
  '/accounts/:id/close',
  requireOffice,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    savingsService
      .closeAccount(getAuth(req), params.id, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);
