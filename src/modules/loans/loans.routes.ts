import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { AppError } from '../../lib/errors.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { acceptSheet } from '../../middleware/sheet-upload.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { z } from 'zod';
import { exportFormat } from '../../schemas/common.js';
import { importRowsBody, type ImportRowsBody } from '../customers/customers.schemas.js';
import {
  applyBody,
  customerIdParams,
  listLoansQuery,
  loanIdParams,
  repaymentIdParams,
  loanTrashQuery,
  paperLoanBody,
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
  type PaperLoanBody,
  type PutConfigBody,
  type RejectBody,
  type RepayBody,
  type SusuRepayBody,
  type TrashBody,
} from './loans.schemas.js';
import {
  correctionBody,
  proposeCorrectionBody,
  type CorrectionBody,
  type ProposeCorrectionBody,
} from '../corrections/corrections.schemas.js';
import * as corrections from '../corrections/corrections.service.js';
import * as loansService from './loans.service.js';
import * as paperLoans from './paper-loans.service.js';
import * as paperImport from './paper-loans.import.js';

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

// Read by the application form the moment a customer is picked.
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

// The counter may take an application; nothing is disbursed until a manager
// approves it below, which is what makes that safe.
loansRouter.post('/applications', validate({ body: applyBody }), (req, res, next) => {
  const { body } = getValidated<{ body: ApplyBody }>(req);
  // The schema insists on exactly one; this only tells the compiler so.
  const guarantor = body.guarantorId ?? body.guarantor ?? body.guarantors;
  if (guarantor === undefined) {
    next(new AppError('VALIDATION_ERROR', 'Give the guarantor', 400));
    return;
  }
  loansService
    .applyForLoan(
      getAuth(req),
      body.customerId,
      body.principal,
      body.durationMonths,
      guarantor,
      body.signatureUrl,
      req.id as string,
    )
    .then((loan) => res.status(201).json({ loan }))
    .catch(next);
});

// A loan made on paper before the system existed, copied in as history. Only
// while ALLOW_BACKDATED_ENTRY is on — the backlog is closed by turning it off.
loansRouter.post('/paper', requireOffice, validate({ body: paperLoanBody }), (req, res, next) => {
  const { body } = getValidated<{ body: PaperLoanBody }>(req);
  paperLoans
    .recordPaperLoan(getAuth(req), body, req.id as string)
    .then((loan) => res.status(201).json({ loan }))
    .catch(next);
});

const templateQuery = z.object({ format: exportFormat });
type TemplateQuery = z.infer<typeof templateQuery>;

// The blank sheet for copying the paper loan book in: one row per payment.
loansRouter.get(
  '/paper/import/template',
  requireOffice,
  validate({ query: templateQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: TemplateQuery }>(req);
    sendExport(res, {
      format: query.format === 'json' ? 'xlsx' : query.format,
      filename: 'paper-loans-template',
      payload: null,
      rows: paperImport.templateRows(),
      sheet: 'Paper loans',
    }).catch(next);
  },
);

// Check an uploaded sheet. Writes nothing.
loansRouter.post('/paper/import/preview', requireOffice, acceptSheet, (req, res, next) => {
  if (!req.file) {
    next(new AppError('VALIDATION_ERROR', 'A "file" field carrying the sheet is required', 400));
    return;
  }
  paperImport
    .previewImportFile(req.file)
    .then((preview) => res.json(preview))
    .catch(next);
});

// Record the loans the sheet describes, loan by loan.
loansRouter.post(
  '/paper/import',
  requireOffice,
  validate({ body: importRowsBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: ImportRowsBody }>(req);
    paperImport
      .importPaperLoans(getAuth(req), body.rows, req.id as string)
      .then((result) => res.status(201).json(result))
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

// Correct the newest cash repayment's amount. Office only: a figure already
// on the ledger is changed by a decision. The counter's door is the request
// below, which the office applies through this same correction.
loansRouter.patch(
  '/:id/repayments/:repaymentId',
  requireOffice,
  validate({ params: repaymentIdParams, body: correctionBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: RepaymentIdParams;
      body: CorrectionBody;
    }>(req);
    corrections
      .correct(
        getAuth(req),
        'loan-repayment',
        params.id,
        params.repaymentId,
        body.amount,
        req.id as string,
      )
      .then((result) => res.json(result))
      .catch(next);
  },
);

// The counter asks; decided under /corrections.
loansRouter.post(
  '/:id/repayments/:repaymentId/corrections',
  validate({ params: repaymentIdParams, body: proposeCorrectionBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: RepaymentIdParams;
      body: ProposeCorrectionBody;
    }>(req);
    corrections
      .propose(
        getAuth(req),
        'loan-repayment',
        params.id,
        params.repaymentId,
        body,
        req.id as string,
      )
      .then((correction) => res.status(201).json({ correction }))
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
