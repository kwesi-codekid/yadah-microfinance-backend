import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  applyBody,
  customerIdParams,
  listLoansQuery,
  loanIdParams,
  repaymentIdParams,
  loanTrashQuery,
  putConfigBody,
  rejectBody,
  repayBody,
  susuRepayBody,
  trashBody,
  type ApplyBody,
  type CustomerIdParams,
  type ListLoansQuery,
  type LoanIdParams,
  type RepaymentIdParams,
  type LoanTrashQuery,
  type PutConfigBody,
  type RejectBody,
  type RepayBody,
  type SusuRepayBody,
  type TrashBody,
} from './loans.schemas.js';
import * as loansService from './loans.service.js';

// Loans are office territory throughout (admin ≡ manager for now).
export const loansRouter = Router();
/**
 * The counter may take a repayment and print a receipt; everything that
 * decides a loan — applying, approving, rejecting, the rates themselves, and
 * the trash — says `requireOffice` on its own line below.
 */
loansRouter.use(requireAuth, requireCounter);

loansRouter.get('/config', (_req, res, next) => {
  loansService
    .getLoanConfig()
    .then((config) => res.json({ config }))
    .catch(next);
});

loansRouter.put('/config', requireOffice, validate({ body: putConfigBody }), (req, res, next) => {
  const { body } = getValidated<{ body: PutConfigBody }>(req);
  loansService
    .putLoanConfig(getAuth(req), body, req.id as string)
    .then((config) => res.json({ config }))
    .catch(next);
});

loansRouter.get(
  '/eligibility/:customerId',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    loansService
      .eligibilitySummary(params.customerId)
      .then((summary) => res.json(summary))
      .catch(next);
  },
);

loansRouter.post(
  '/applications',
  requireOffice,
  validate({ body: applyBody }),
  (req, res, next) => {
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
  },
);

loansRouter.get('/', validate({ query: listLoansQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListLoansQuery }>(req);
  if (query.format !== 'json') {
    loansService
      .listLoans({ ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'loans',
          payload: null,
          rows: list.items.map(loansService.toLoanExportRow),
          moneyKeys: ['principal', 'interestAmount', 'totalDue', 'totalRepaid', 'remaining'],
          sheet: 'Loans',
        }),
      )
      .catch(next);
    return;
  }
  loansService
    .listLoans(query)
    .then((list) => res.json(list))
    .catch(next);
});

// Registered BEFORE '/:id' so 'trash' is never captured as a loan id.
loansRouter.get('/trash', requireOffice, validate({ query: loanTrashQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: LoanTrashQuery }>(req);
  loansService
    .listLoanTrash(query)
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

loansRouter.delete(
  '/:id',
  requireOffice,
  validate({ params: loanIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: LoanIdParams; body: TrashBody }>(req);
    loansService
      .trashLoan(getAuth(req), params.id, body.reason, req.id as string)
      .then((loan) => res.json({ loan }))
      .catch(next);
  },
);

loansRouter.post(
  '/:id/restore',
  requireOffice,
  validate({ params: loanIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: LoanIdParams }>(req);
    loansService
      .restoreLoan(getAuth(req), params.id, req.id as string)
      .then((loan) => res.json({ loan }))
      .catch(next);
  },
);

loansRouter.post(
  '/:id/approve',
  requireOffice,
  validate({ params: loanIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: LoanIdParams }>(req);
    loansService
      .approveLoan(getAuth(req), params.id, req.id as string)
      .then((loan) => res.json({ loan }))
      .catch(next);
  },
);

loansRouter.post(
  '/:id/reject',
  requireOffice,
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
        body.excessTo,
        req.id as string,
      )
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
      .catch(next);
  },
);

// ---------------------------------------------------------------- receipts
// Office-only like the rest of this router: loans are collected at the counter,
// never on a collector's round.

// Proof the customer received the money.
loansRouter.get(
  '/:id/disbursement/receipt',
  validate({ params: loanIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: LoanIdParams }>(req);
    loansService
      .disbursementReceipt(params.id)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);

// Proof the customer paid.
loansRouter.get(
  '/:id/repayments/:repaymentId/receipt',
  validate({ params: repaymentIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: RepaymentIdParams }>(req);
    loansService
      .repaymentReceipt(params.id, params.repaymentId)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);
