import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  accountIdParams,
  depositBody,
  listAccountsQuery,
  listTxnsQuery,
  openAccountBody,
  txnIdParams,
  type AccountIdParams,
  type DepositBody,
  type ListAccountsQuery,
  type ListTxnsQuery,
  type OpenAccountBody,
  type TxnIdParams,
} from './susu-loans.schemas.js';
import * as service from './susu-loans.service.js';

/**
 * The susu loan account. Everything that moves money is done at the office
 * only (client decision, 23 Oct 2026) — collectors do not take susu loan
 * deposits on their rounds — and there is no withdrawal route at all.
 */
export const susuLoansRouter = Router();
susuLoansRouter.use(requireAuth, requireCounter);

susuLoansRouter.post(
  '/accounts',
  requireCounter,
  validate({ body: openAccountBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: OpenAccountBody }>(req);
    service
      .openAccount(
        getAuth(req),
        body.customerId,
        body.initialDeposit,
        body.idempotencyKey,
        req.id as string,
      )
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);

susuLoansRouter.get('/accounts', validate({ query: listAccountsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListAccountsQuery }>(req);
  service
    .listAccounts(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

susuLoansRouter.get('/accounts/:id', validate({ params: accountIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: AccountIdParams }>(req);
  service
    .getAccount(getAuth(req), params.id)
    .then((account) => res.json({ account }))
    .catch(next);
});

susuLoansRouter.get(
  '/accounts/:id/txns',
  validate({ params: accountIdParams, query: listTxnsQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: AccountIdParams; query: ListTxnsQuery }>(req);
    service
      .listTxns(getAuth(req), params.id, query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

susuLoansRouter.get(
  '/accounts/:id/txns/:txnId/receipt',
  validate({ params: txnIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: TxnIdParams }>(req);
    service
      .txnReceipt(getAuth(req), params.id, params.txnId)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);

susuLoansRouter.post(
  '/accounts/:id/deposits',
  requireCounter,
  validate({ params: accountIdParams, body: depositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: DepositBody }>(req);
    service
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

susuLoansRouter.post(
  '/accounts/:id/close',
  requireCounter,
  validate({ params: accountIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: AccountIdParams }>(req);
    service
      .closeAccount(getAuth(req), params.id, req.id as string)
      .then((account) => res.json({ account }))
      .catch(next);
  },
);
