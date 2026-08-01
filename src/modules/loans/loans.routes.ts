import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  applyBody,
  customerIdParams,
  listLoansQuery,
  loanIdParams,
  putConfigBody,
  rejectBody,
  repayBody,
  susuRepayBody,
  type ApplyBody,
  type CustomerIdParams,
  type ListLoansQuery,
  type LoanIdParams,
  type PutConfigBody,
  type RejectBody,
  type RepayBody,
  type SusuRepayBody,
} from './loans.schemas.js';
import * as loansService from './loans.service.js';

// Loans are office territory throughout (admin ≡ manager for now).
export const loansRouter = Router();
loansRouter.use(requireAuth, requireOffice);

loansRouter.get('/config', (_req, res, next) => {
  loansService
    .getLoanConfig()
    .then((config) => res.json({ config }))
    .catch(next);
});

loansRouter.put('/config', validate({ body: putConfigBody }), (req, res, next) => {
  const { body } = getValidated<{ body: PutConfigBody }>(req);
  loansService
    .putLoanConfig(getAuth(req), body, req.id as string)
    .then((config) => res.json({ config }))
    .catch(next);
});

loansRouter.get(
  '/eligibility/:customerId',
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    loansService
      .eligibilitySummary(params.customerId)
      .then((summary) => res.json(summary))
      .catch(next);
  },
);

loansRouter.post('/applications', validate({ body: applyBody }), (req, res, next) => {
  const { body } = getValidated<{ body: ApplyBody }>(req);
  loansService
    .applyForLoan(
      getAuth(req),
      body.customerId,
      body.principal,
      body.durationMonths,
      req.id as string,
    )
    .then((loan) => res.status(201).json({ loan }))
    .catch(next);
});

loansRouter.get('/', validate({ query: listLoansQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListLoansQuery }>(req);
  loansService
    .listLoans(query)
    .then((list) => res.json(list))
    .catch(next);
});

loansRouter.get('/:id', validate({ params: loanIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: LoanIdParams }>(req);
  loansService
    .getLoan(params.id)
    .then((detail) => res.json(detail))
    .catch(next);
});

loansRouter.post('/:id/approve', validate({ params: loanIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: LoanIdParams }>(req);
  loansService
    .approveLoan(getAuth(req), params.id, req.id as string)
    .then((loan) => res.json({ loan }))
    .catch(next);
});

loansRouter.post(
  '/:id/reject',
  validate({ params: loanIdParams, body: rejectBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: LoanIdParams; body: RejectBody }>(req);
    loansService
      .rejectLoan(getAuth(req), params.id, body.reason, req.id as string)
      .then((loan) => res.json({ loan }))
      .catch(next);
  },
);

loansRouter.post(
  '/:id/repayments',
  validate({ params: loanIdParams, body: repayBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: LoanIdParams; body: RepayBody }>(req);
    loansService
      .repayCash(
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

loansRouter.post(
  '/:id/repayments/susu-closure',
  validate({ params: loanIdParams, body: susuRepayBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: LoanIdParams; body: SusuRepayBody }>(req);
    loansService
      .repayViaSusuClosure(
        getAuth(req),
        params.id,
        body.susuAccountId,
        body.idempotencyKey,
        req.id as string,
      )
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);
