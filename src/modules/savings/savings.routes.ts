import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  accountIdParams,
  depositBody,
  listAccountsQuery,
  listTrashQuery,
  listTxnsQuery,
  openAccountBody,
  trashBody,
  txnIdParams,
  withdrawalBody,
  type AccountIdParams,
  type DepositBody,
  type ListAccountsQuery,
  type ListTrashQuery,
  type ListTxnsQuery,
  type OpenAccountBody,
  type TrashBody,
  type TxnIdParams,
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

// Registered BEFORE /accounts/:id so 'trash' is not captured as an id.
savingsRouter.get(
  '/accounts/trash',
  requireOffice,
  validate({ query: listTrashQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: ListTrashQuery }>(req);
    savingsService
      .listSavingsAccountTrash(getAuth(req), query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

savingsRouter.get('/accounts/:id', validate({ params: accountIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: AccountIdParams }>(req);
  savingsService
    .getAccount(getAuth(req), params.id)
    .then((account) => res.json({ account }))
    .catch(next);
});

// Move an empty, unused account to the trash (office only).
savingsRouter.delete(
  '/accounts/:id',
  requireOffice,
  validate({ params: accountIdParams, body: trashBody.optional() }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body?: TrashBody }>(req);
    savingsService
      .trashSavingsAccount(getAuth(req), params.id, body?.reason, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

savingsRouter.post(
  '/accounts/:id/restore',
  requireOffice,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    savingsService
      .restoreSavingsAccount(getAuth(req), params.id, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

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

// Trashed transactions of one account (office only).
savingsRouter.get(
  '/accounts/:id/transactions/trash',
  requireOffice,
  validate({ params: accountIdParams, query: listTrashQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListTrashQuery }>(req);
    savingsService
      .listSavingsTxnTrash(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

// Trash a mistaken deposit/withdrawal — reverses the balance atomically.
savingsRouter.delete(
  '/accounts/:id/transactions/:txnId',
  requireOffice,
  validate({ params: txnIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: TxnIdParams; body: TrashBody }>(req);
    savingsService
      .trashSavingsTxn(getAuth(req), params.id, params.txnId, body.reason, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

savingsRouter.post(
  '/accounts/:id/transactions/:txnId/restore',
  requireOffice,
  validate({ params: txnIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: TxnIdParams }>(req);
    savingsService
      .restoreSavingsTxn(getAuth(req), params.id, params.txnId, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

// Any collector or office staff records deposits.
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
