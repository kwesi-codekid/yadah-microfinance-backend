import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { pagination, trashBody, type Pagination, type TrashBody } from '../../schemas/common.js';
import {
  createCustomerBody,
  customerIdParams,
  listCustomersQuery,
  updateCustomerBody,
  type CreateCustomerBody,
  type CustomerIdParams,
  type ListCustomersQuery,
  type UpdateCustomerBody,
} from './customers.schemas.js';
import * as customersService from './customers.service.js';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { rangeQuery, type RangeQuery } from '../reports/reports.schemas.js';
import { customerStatement, statementCsvRows } from '../reports/transactions.service.js';

export const customersRouter = Router();
customersRouter.use(requireAuth);

// Office only — client rule: account creation happens at the office, never in the field.
customersRouter.post(
  '/',
  requireOffice,
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
customersRouter.get(
  '/:id/registration-form',
  requireOffice,
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
customersRouter.get(
  '/:id/statement',
  requireOffice,
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

customersRouter.patch(
  '/:id',
  requireOffice,
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
