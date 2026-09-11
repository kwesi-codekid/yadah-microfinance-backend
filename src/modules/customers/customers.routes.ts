import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireAdmin, requireCounter, requireOffice } from '../../middleware/rbac.js';
import { acceptSheet } from '../../middleware/sheet-upload.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { z } from 'zod';
import {
  exportFormat,
  pagination,
  trashBody,
  type Pagination,
  type TrashBody,
} from '../../schemas/common.js';
import {
  bulkReassignBody,
  createCustomerBody,
  customerIdParams,
  importRowsBody,
  listCustomersQuery,
  reassignCollectorBody,
  updateCustomerBody,
  type BulkReassignBody,
  type CreateCustomerBody,
  type CustomerIdParams,
  type ImportRowsBody,
  type ListCustomersQuery,
  type ReassignCollectorBody,
  type UpdateCustomerBody,
} from './customers.schemas.js';
import * as customersService from './customers.service.js';
import * as customersImport from './customers.import.js';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { rangeQuery, type RangeQuery } from '../reports/reports.schemas.js';
import { customerStatement, statementCsvRows } from '../reports/transactions.service.js';

export const customersRouter = Router();
customersRouter.use(requireAuth);

// The counter, not the field: registration happens where the person is
// standing, which is a teller's job as much as a manager's.
customersRouter.post(
  '/',
  requireCounter,
  validate({ body: createCustomerBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: CreateCustomerBody }>(req);
    customersService
      .createCustomer(getAuth(req), body, req.id as string)
      .then((customer) => res.status(201).json({ customer }))
      .catch(next);
  },
);

// All roles list — collectors see only their own assigned customers.
customersRouter.get('/', validate({ query: listCustomersQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListCustomersQuery }>(req);
  if (query.format !== 'json') {
    // Exports ignore client pagination; capped by EXPORT_MAX_ROWS instead.
    customersService
      .listCustomers(getAuth(req), { ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'customers',
          payload: null,
          rows: list.items.map(customersService.toCustomerExportRow),
          sheet: 'Customers',
        }),
      )
      .catch(next);
    return;
  }
  customersService
    .listCustomers(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

// Hand a whole round from one collector to another (admin only). Registered
// BEFORE /:id so 'reassign-collector' is never captured as an id.
customersRouter.post(
  '/reassign-collector',
  requireAdmin,
  validate({ body: bulkReassignBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: BulkReassignBody }>(req);
    customersService
      .bulkReassignCollector(getAuth(req), body, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

/* ------------------------------------------------------------ bulk import ---
 * Registered BEFORE /:id so 'import' is never captured as a customer id.
 *
 * Three steps, and only the last one writes: take the template, upload the
 * filled sheet for checking, then send back the rows the office accepted.
 */

/** The template is a download, so csv is the sensible default rather than json. */
const templateQuery = z.object({ format: exportFormat });
type TemplateQuery = z.infer<typeof templateQuery>;

// The blank sheet, with the headings the importer reads and one example row.
customersRouter.get(
  '/import/template',
  requireOffice,
  validate({ query: templateQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: TemplateQuery }>(req);
    sendExport(res, {
      format: query.format === 'json' ? 'csv' : query.format,
      filename: 'customer-import-template',
      payload: null,
      rows: customersImport.templateRows(),
      sheet: 'Customers',
    }).catch(next);
  },
);

// Check an uploaded sheet. Writes nothing — the answer is what the preview
// screen shows, cell by cell, before anyone commits to it.
customersRouter.post('/import/preview', requireOffice, acceptSheet, (req, res, next) => {
  if (!req.file) {
    next(new AppError('VALIDATION_ERROR', 'A "file" field carrying the sheet is required', 400));
    return;
  }
  customersImport
    .previewImportFile(req.file)
    .then((preview) => res.json(preview))
    .catch(next);
});

// Register the corrected rows. Row by row: what fails comes back with why.
customersRouter.post(
  '/import',
  requireOffice,
  validate({ body: importRowsBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: ImportRowsBody }>(req);
    customersImport
      .importCustomers(getAuth(req), body.rows, req.id as string)
      .then((result) => res.status(201).json(result))
      .catch(next);
  },
);

// Trash listing — registered BEFORE /:id so 'trash' is never captured as an id.
customersRouter.get('/trash', requireOffice, validate({ query: pagination }), (req, res, next) => {
  const { query } = getValidated<{ query: Pagination }>(req);
  customersService
    .listCustomerTrash(getAuth(req), query)
    .then((list) => res.json(list))
    .catch(next);
});

customersRouter.get('/:id', validate({ params: customerIdParams }), (req, res, next) => {
  const { params } = getValidated<{ params: CustomerIdParams }>(req);
  customersService
    .getCustomer(getAuth(req), params.id)
    .then((customer) => res.json({ customer }))
    .catch(next);
});

// Printable registration form (office only — full PII, same gate as /statement).
// Printed at the desk while the customer is there, so the counter prints it.
customersRouter.get(
  '/:id/registration-form',
  requireCounter,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .registrationFormPdf(getAuth(req), params.id)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);

// Statement of account: all products + unified transaction history for a period.
// Asked for across the counter more often than anywhere else.
customersRouter.get(
  '/:id/statement',
  requireCounter,
  validate({ params: customerIdParams, query: rangeQuery }),
  (req, res, next) => {
    const { params, query } = getValidated<{ params: CustomerIdParams; query: RangeQuery }>(req);
    customerStatement(params.id, query.from, query.to)
      .then((statement) => {
        if (query.format !== 'json') {
          const name = `statement-${statement.customer.id}-${statement.period.from}-to-${statement.period.to}`;
          return sendExport(res, {
            format: query.format,
            filename: name,
            payload: null,
            rows: statementCsvRows(statement),
            moneyKeys: ['amount', 'fee', 'balanceAfter'],
            sheet: 'Statement',
          });
        }
        res.json(statement);
        return undefined;
      })
      .catch(next);
  },
);

// Whoever may register a customer may fix what they typed.
customersRouter.patch(
  '/:id',
  requireCounter,
  validate({ params: customerIdParams, body: updateCustomerBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: CustomerIdParams; body: UpdateCustomerBody }>(
      req,
    );
    customersService
      .updateCustomer(getAuth(req), params.id, body, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

// Move one customer to another collector — admin only: a manager may edit a
// customer but must not silently move collection responsibility.
customersRouter.patch(
  '/:id/collector',
  requireAdmin,
  validate({ params: customerIdParams, body: reassignCollectorBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{
      params: CustomerIdParams;
      body: ReassignCollectorBody;
    }>(req);
    customersService
      .reassignCollector(getAuth(req), params.id, body, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

customersRouter.post(
  '/:id/deactivate',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .setCustomerStatus(getAuth(req), params.id, 'inactive', req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

customersRouter.post(
  '/:id/activate',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .setCustomerStatus(getAuth(req), params.id, 'active', req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

// Soft delete — refused while the customer still has open products.
customersRouter.delete(
  '/:id',
  requireOffice,
  validate({ params: customerIdParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: CustomerIdParams; body: TrashBody }>(req);
    customersService
      .trashCustomer(getAuth(req), params.id, body.reason, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);

customersRouter.post(
  '/:id/restore',
  requireOffice,
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    customersService
      .restoreCustomer(getAuth(req), params.id, req.id as string)
      .then((customer) => res.json({ customer }))
      .catch(next);
  },
);
