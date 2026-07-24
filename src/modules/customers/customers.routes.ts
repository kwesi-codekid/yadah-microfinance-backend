import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
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

export const customersRouter = Router();
customersRouter.use(requireAuth);

// All roles create — collectors register in the field, assigned to themselves.
customersRouter.post('/', validate({ body: createCustomerBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateCustomerBody }>(req);
  customersService
    .createCustomer(getAuth(req), body, req.id as string)
    .then((customer) => res.status(201).json({ customer }))
    .catch(next);
});

// All roles list — collectors see only their own assigned customers.
customersRouter.get('/', validate({ query: listCustomersQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListCustomersQuery }>(req);
  customersService
    .listCustomers(getAuth(req), query)
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
