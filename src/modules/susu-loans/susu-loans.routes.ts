import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  accountIdParams,
  depositBody,
  editAccountBody,
  editDepositBody,
  listAccountsQuery,
  listTxnsQuery,
  openAccountBody,
  txnIdParams,
  type AccountIdParams,
  type DepositBody,
  type EditAccountBody,
  type EditDepositBody,
  type ListAccountsQuery,
  type ListTxnsQuery,
  type OpenAccountBody,
  type TxnIdParams,
} from './susu-loans.schemas.js';
import * as service from './susu-loans.service.js';
import {
  proposeCorrectionBody,
  type ProposeCorrectionBody,
} from '../corrections/corrections.schemas.js';
import * as corrections from '../corrections/corrections.service.js';

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
        body.occurredOn,
        body.collectorId,
      )
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

// Editing is the office's; the counter asks for an amount to be corrected below.
susuLoansRouter.patch(
  '/accounts/:id',
  requireOffice,
  validate({ params: accountIdParams, body: editAccountBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: AccountIdParams; body: EditAccountBody }>(req);
    service
      .editAccount(getAuth(req), params.id, body, req.id as string)
      .then((account) => res.json({ account }))
      .catch(next);
  },
);

susuLoansRouter.patch(
  '/accounts/:id/txns/:txnId',
  requireOffice,
  validate({ params: txnIdParams, body: editDepositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: TxnIdParams; body: EditDepositBody }>(req);
    service
      .editDeposit(getAuth(req), params.id, params.txnId, body, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

susuLoansRouter.post(
  '/accounts/:id/txns/:txnId/corrections',
  validate({ params: txnIdParams, body: proposeCorrectionBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: TxnIdParams; body: ProposeCorrectionBody }>(
      req,
    );
    corrections
      .propose(getAuth(req), 'susu-loan-deposit', params.id, params.txnId, body, req.id as string)
      .then((correction) => res.status(201).json({ correction }))
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
