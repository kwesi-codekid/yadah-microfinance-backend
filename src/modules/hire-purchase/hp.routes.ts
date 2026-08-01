import { Router } from 'express';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  customerIdParams,
  depositBody,
  idParams,
  listAgreementsQuery,
  listItemsQuery,
  putConfigBody,
  reasonBody,
  updateItemBody,
  type AdjustStockBody,
  type CreateAgreementBody,
  type CreateItemBody,
  type CustomerIdParams,
  type DepositBody,
  type IdParams,
  type ListAgreementsQuery,
  type ListItemsQuery,
  type PutConfigBody,
  type ReasonBody,
  type UpdateItemBody,
} from './hp.schemas.js';
import * as hp from './hp.service.js';

// Hire purchase is office territory throughout (admin ≡ manager).
export const hpRouter = Router();
hpRouter.use(requireAuth, requireOffice);

// ---- inventory

hpRouter.post('/items', validate({ body: createItemBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateItemBody }>(req);
  hp.createItem(getAuth(req), body, req.id as string)
    .then((item) => res.status(201).json({ item }))
    .catch(next);
});

hpRouter.get('/items', validate({ query: listItemsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListItemsQuery }>(req);
  hp.listItems(query)
    .then((list) => res.json(list))
    .catch(next);
});

hpRouter.patch(
  '/items/:id',
  validate({ params: idParams, body: updateItemBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: UpdateItemBody }>(req);
    hp.updateItem(getAuth(req), params.id, body, req.id as string)
      .then((item) => res.json({ item }))
      .catch(next);
  },
);

hpRouter.post(
  '/items/:id/adjust-stock',
  validate({ params: idParams, body: adjustStockBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: AdjustStockBody }>(req);
    hp.adjustStock(getAuth(req), params.id, body.delta, body.reason, req.id as string)
      .then((item) => res.json({ item }))
      .catch(next);
  },
);

// ---- config

hpRouter.get('/config', (_req, res, next) => {
  hp.getHpConfig()
    .then((config) => res.json({ config }))
    .catch(next);
});

hpRouter.put('/config', validate({ body: putConfigBody }), (req, res, next) => {
  const { body } = getValidated<{ body: PutConfigBody }>(req);
  hp.putHpConfig(getAuth(req), body.interestRatePercent, req.id as string)
    .then((config) => res.json({ config }))
    .catch(next);
});

// ---- eligibility

hpRouter.get(
  '/eligibility/:customerId',
  validate({ params: customerIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: CustomerIdParams }>(req);
    hp.hpEligibility(params.customerId)
      .then((summary) => res.json(summary))
      .catch(next);
  },
);

// ---- agreements

hpRouter.post('/agreements', validate({ body: createAgreementBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateAgreementBody }>(req);
  hp.createAgreement(getAuth(req), body, req.id as string)
    .then((agreement) => res.status(201).json({ agreement }))
    .catch(next);
});

hpRouter.get('/agreements', validate({ query: listAgreementsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListAgreementsQuery }>(req);
  hp.listAgreements(query)
    .then((list) => res.json(list))
    .catch(next);
});

hpRouter.get('/agreements/:id', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.getAgreement(params.id)
    .then((detail) => res.json(detail))
    .catch(next);
});

hpRouter.post(
  '/agreements/:id/deposit',
  validate({ params: idParams, body: depositBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: DepositBody }>(req);
    hp.recordDeposit(
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

hpRouter.post(
  '/agreements/:id/reject',
  validate({ params: idParams, body: reasonBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: ReasonBody }>(req);
    hp.rejectAgreement(getAuth(req), params.id, body.reason, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post('/agreements/:id/mark-arrears', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.markArrears(getAuth(req), params.id, req.id as string)
    .then((agreement) => res.json({ agreement }))
    .catch(next);
});

hpRouter.post(
  '/agreements/:id/repossess',
  validate({ params: idParams, body: reasonBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: ReasonBody }>(req);
    hp.repossess(getAuth(req), params.id, body.reason, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post('/agreements/:id/forfeit', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.forfeit(getAuth(req), params.id, req.id as string)
    .then((agreement) => res.json({ agreement }))
    .catch(next);
});
