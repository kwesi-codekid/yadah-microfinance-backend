import { Router } from 'express';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  customerIdParams,
  depositBody,
  forfeitBody,
  idParams,
  listAgreementsQuery,
  listItemsQuery,
  listSalesQuery,
  paymentBody,
  putConfigBody,
  reasonBody,
  recordSaleBody,
  redeemBody,
  trashBody,
  voidSaleBody,
  trashListQuery,
  updateItemBody,
  type AdjustStockBody,
  type CreateAgreementBody,
  type CreateItemBody,
  type CustomerIdParams,
  type DepositBody,
  type ForfeitBody,
  type IdParams,
  type ListAgreementsQuery,
  type ListItemsQuery,
  type ListSalesQuery,
  type PaymentBody,
  type PutConfigBody,
  type ReasonBody,
  type RecordSaleBody,
  type RedeemBody,
  type TrashBody,
  type TrashListQuery,
  type UpdateItemBody,
  type VoidSaleBody,
} from './hp.schemas.js';
import * as hp from './hp.service.js';

// Hire purchase is office territory throughout (admin ≡ manager).
export const hpRouter = Router();
hpRouter.use(requireAuth, requireOffice);

// ---- outright sales (counter / POS)
//
// Registered before /agreements/:id-style routes so nothing shadows them.
// Stock out, money in, no agreement — the buyer need not be a registered
// customer, since requiring a photo and an ID to sell a kettle is absurd.

hpRouter.post('/sales', validate({ body: recordSaleBody }), (req, res, next) => {
  const { body } = getValidated<{ body: RecordSaleBody }>(req);
  hp.recordSale(getAuth(req), body, req.id as string)
    .then((result) => res.status(result.replayed ? 200 : 201).json(result))
    .catch(next);
});

hpRouter.get('/sales', validate({ query: listSalesQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListSalesQuery }>(req);
  if (query.format !== 'json') {
    hp.listSalesForExport(query)
      .then((rows) =>
        sendExport(res, {
          format: query.format,
          filename: 'outright-sales',
          payload: null,
          rows,
          moneyKeys: ['subtotal', 'discount', 'total', 'totalCost', 'profit'],
          sheet: 'Sales',
        }),
      )
      .catch(next);
    return;
  }
  hp.listSales(query)
    .then((list) => res.json(list))
    .catch(next);
});

hpRouter.get('/sales/:id', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.getSale(params.id)
    .then((sale) => res.json({ sale }))
    .catch(next);
});

hpRouter.get('/sales/:id/receipt', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.saleReceipt(params.id)
    .then(({ buffer, filename }) => {
      res.type('application/pdf').attachment(filename).send(buffer);
    })
    .catch(next);
});

// Reverses a sale rung up in error: stock back, revenue off, row retained.
hpRouter.post(
  '/sales/:id/void',
  validate({ params: idParams, body: voidSaleBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: VoidSaleBody }>(req);
    hp.voidSale(getAuth(req), params.id, body.reason, req.id as string)
      .then((sale) => res.json({ sale }))
      .catch(next);
  },
);

// ---- inventory

hpRouter.post('/items', validate({ body: createItemBody }), (req, res, next) => {
  const { body } = getValidated<{ body: CreateItemBody }>(req);
  hp.createItem(getAuth(req), body, req.id as string)
    .then((item) => res.status(201).json({ item }))
    .catch(next);
});

hpRouter.get('/items', validate({ query: listItemsQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListItemsQuery }>(req);
  if (query.format !== 'json') {
    hp.listItems({ ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'hp-items',
          payload: null,
          rows: list.items.map(hp.toHpItemExportRow),
          moneyKeys: ['costPrice', 'sellingPrice'],
          sheet: 'HP items',
        }),
      )
      .catch(next);
    return;
  }
  hp.listItems(query)
    .then((list) => res.json(list))
    .catch(next);
});

// Registered before the /items/:id routes so 'trash' is never read as an id.
hpRouter.get('/items/trash', validate({ query: trashListQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: TrashListQuery }>(req);
  hp.listHpItemTrash(query)
    .then((list) => res.json(list))
    .catch(next);
});

hpRouter.delete('/items/:id', validate({ params: idParams, body: trashBody }), (req, res, next) => {
  const { params, body } = getValidated<{ params: IdParams; body: TrashBody }>(req);
  hp.trashHpItem(getAuth(req), params.id, body.reason, req.id as string)
    .then((item) => res.json({ item }))
    .catch(next);
});

hpRouter.post('/items/:id/restore', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.restoreHpItem(getAuth(req), params.id, req.id as string)
    .then((item) => res.json({ item }))
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
  if (query.format !== 'json') {
    hp.listAgreements({ ...query, page: 1, limit: EXPORT_MAX_ROWS })
      .then((list) =>
        sendExport(res, {
          format: query.format,
          filename: 'hp-agreements',
          payload: null,
          rows: list.items.map(hp.toHpAgreementExportRow),
          moneyKeys: [
            'depositRequired',
            'financedAmount',
            'totalPayable',
            'totalPaid',
            'remaining',
          ],
          sheet: 'HP agreements',
        }),
      )
      .catch(next);
    return;
  }
  hp.listAgreements(query)
    .then((list) => res.json(list))
    .catch(next);
});

// Registered before the /agreements/:id routes so 'trash' is never read as an id.
hpRouter.get('/agreements/trash', validate({ query: trashListQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: TrashListQuery }>(req);
  hp.listHpAgreementTrash(query)
    .then((list) => res.json(list))
    .catch(next);
});

hpRouter.delete(
  '/agreements/:id',
  validate({ params: idParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: TrashBody }>(req);
    hp.trashHpAgreement(getAuth(req), params.id, body.reason, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post('/agreements/:id/restore', validate({ params: idParams }), (req, res, next) => {
  const { params } = getValidated<{ params: IdParams }>(req);
  hp.restoreHpAgreement(getAuth(req), params.id, req.id as string)
    .then((agreement) => res.json({ agreement }))
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

hpRouter.post(
  '/agreements/:id/payments',
  validate({ params: idParams, body: paymentBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: PaymentBody }>(req);
    hp.payInstallment(
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
  '/agreements/:id/redeem',
  validate({ params: idParams, body: redeemBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: RedeemBody }>(req);
    hp.redeem(getAuth(req), params.id, body.idempotencyKey, body.channel, req.id as string)
      .then((result) => res.status(result.replayed ? 200 : 201).json(result))
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

hpRouter.post(
  '/agreements/:id/forfeit',
  validate({ params: idParams, body: forfeitBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: ForfeitBody }>(req);
    hp.forfeit(getAuth(req), params.id, body.restock, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);
