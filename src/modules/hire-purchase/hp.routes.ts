import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { EXPORT_MAX_ROWS, sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireCounter, requireOffice } from '../../middleware/rbac.js';
import { acceptSheet } from '../../middleware/sheet-upload.js';
import { getValidated, validate } from '../../middleware/validate.js';
import { exportFormat } from '../../schemas/common.js';
import {
  adjustStockBody,
  createAgreementBody,
  createItemBody,
  customerIdParams,
  depositBody,
  forfeitBody,
  idParams,
  importItemRowsBody,
  labelBody,
  listLabelsQuery,
  updateLabelBody,
  paymentIdParams,
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
  type ImportItemRowsBody,
  type LabelBody,
  type ListLabelsQuery,
  type UpdateLabelBody,
  type PaymentIdParams,
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
import * as hpImport from './hp.import.js';
import * as hpLabels from './hp-labels.service.js';
import type { HpLabelKind } from '../../models/index.js';

export const hpRouter = Router();
/**
 * The counter rings up a sale, keeps the shelf, signs an agreement and takes
 * a payment against it. Everything that decides — approving, rejecting,
 * repossessing, the rates, and the trash — says `requireOffice` on its own
 * line.
 */
hpRouter.use(requireAuth, requireCounter);

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
  requireOffice,
  validate({ params: idParams, body: voidSaleBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: VoidSaleBody }>(req);
    hp.voidSale(getAuth(req), params.id, body.reason, req.id as string)
      .then((sale) => res.json({ sale }))
      .catch(next);
  },
);

// ---- inventory
//
// The shelf is the counter's to keep: whoever sells off it stocks it, prices
// it and counts it. Taking an item out of the listings, or bringing it back,
// stays with the office.

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

// ---- brands and categories
//
// The two managed lists an item is filed under. Written out twice rather than
// looped, because the access tests read these files for literal paths.
// Adding, renaming and describing are counter work; deleting is the office's,
// and refused while any item is still filed under the label.

function labelHandlers(kind: HpLabelKind) {
  return {
    list: (req: Request, res: Response, next: NextFunction) => {
      const { query } = getValidated<{ query: ListLabelsQuery }>(req);
      hpLabels
        .listLabels(kind, query)
        .then((list) => res.json(list))
        .catch(next);
    },
    get: (req: Request, res: Response, next: NextFunction) => {
      const { params } = getValidated<{ params: IdParams }>(req);
      hpLabels
        .getLabel(kind, params.id)
        .then((label) => res.json({ label }))
        .catch(next);
    },
    create: (req: Request, res: Response, next: NextFunction) => {
      const { body } = getValidated<{ body: LabelBody }>(req);
      hpLabels
        .createLabel(getAuth(req), kind, body, req.id as string)
        .then((label) => res.status(201).json({ label }))
        .catch(next);
    },
    update: (req: Request, res: Response, next: NextFunction) => {
      const { params, body } = getValidated<{ params: IdParams; body: UpdateLabelBody }>(req);
      hpLabels
        .updateLabel(getAuth(req), kind, params.id, body, req.id as string)
        .then((label) => res.json({ label }))
        .catch(next);
    },
    remove: (req: Request, res: Response, next: NextFunction) => {
      const { params } = getValidated<{ params: IdParams }>(req);
      hpLabels
        .deleteLabel(getAuth(req), kind, params.id, req.id as string)
        .then(() => res.status(204).end())
        .catch(next);
    },
  };
}

const brands = labelHandlers('brand');
hpRouter.get('/brands', validate({ query: listLabelsQuery }), brands.list);
hpRouter.post('/brands', validate({ body: labelBody }), brands.create);
hpRouter.get('/brands/:id', validate({ params: idParams }), brands.get);
hpRouter.patch('/brands/:id', validate({ params: idParams, body: updateLabelBody }), brands.update);

const categories = labelHandlers('category');
hpRouter.get('/categories', validate({ query: listLabelsQuery }), categories.list);
hpRouter.post('/categories', validate({ body: labelBody }), categories.create);
hpRouter.get('/categories/:id', validate({ params: idParams }), categories.get);
hpRouter.patch(
  '/categories/:id',
  validate({ params: idParams, body: updateLabelBody }),
  categories.update,
);

// Deleting is the office's, and is refused while any item is still filed
// under the label. The two are registered here, apart from the counter's
// routes above, because the access tests read a few lines past each route
// for its guard: a `requireOffice` sitting right under a counter route would
// read as belonging to it.
//
hpRouter.delete('/brands/:id', requireOffice, validate({ params: idParams }), brands.remove);
hpRouter.delete(
  '/categories/:id',
  requireOffice,
  validate({ params: idParams }),
  categories.remove,
);

/* ------------------------------------------------------------ bulk import ---
 * Registered BEFORE /items/:id so 'import' is never read as an item id.
 *
 * Three steps, and only the last one writes: take the template, upload the
 * filled sheet for checking, then send back the rows that were accepted.
 */

const templateQuery = z.object({ format: exportFormat });
type TemplateQuery = z.infer<typeof templateQuery>;

hpRouter.get('/items/import/template', validate({ query: templateQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: TemplateQuery }>(req);
  sendExport(res, {
    format: query.format === 'json' ? 'csv' : query.format,
    filename: 'inventory-import-template',
    payload: null,
    rows: hpImport.templateRows(),
    sheet: 'Inventory',
  }).catch(next);
});

hpRouter.post('/items/import/preview', acceptSheet, (req, res, next) => {
  if (!req.file) {
    next(new AppError('VALIDATION_ERROR', 'A "file" field carrying the sheet is required', 400));
    return;
  }
  hpImport
    .previewImportFile(req.file)
    .then((preview) => res.json(preview))
    .catch(next);
});

hpRouter.post('/items/import', validate({ body: importItemRowsBody }), (req, res, next) => {
  const { body } = getValidated<{ body: ImportItemRowsBody }>(req);
  hpImport
    .importItems(getAuth(req), body.rows, req.id as string)
    .then((result) => res.status(201).json(result))
    .catch(next);
});

// Registered before the /items/:id routes so 'trash' is never read as an id.
hpRouter.get(
  '/items/trash',
  requireOffice,
  validate({ query: trashListQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: TrashListQuery }>(req);
    hp.listHpItemTrash(query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

hpRouter.delete(
  '/items/:id',
  requireOffice,
  validate({ params: idParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: TrashBody }>(req);
    hp.trashHpItem(getAuth(req), params.id, body.reason, req.id as string)
      .then((item) => res.json({ item }))
      .catch(next);
  },
);

hpRouter.post(
  '/items/:id/restore',
  requireOffice,
  validate({ params: idParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    hp.restoreHpItem(getAuth(req), params.id, req.id as string)
      .then((item) => res.json({ item }))
      .catch(next);
  },
);

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

hpRouter.put('/config', requireOffice, validate({ body: putConfigBody }), (req, res, next) => {
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

// The counter may sign one; it waits on a manager unless the office signed it.
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
hpRouter.get(
  '/agreements/trash',
  requireOffice,
  validate({ query: trashListQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: TrashListQuery }>(req);
    hp.listHpAgreementTrash(query)
      .then((list) => res.json(list))
      .catch(next);
  },
);

hpRouter.delete(
  '/agreements/:id',
  requireOffice,
  validate({ params: idParams, body: trashBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: TrashBody }>(req);
    hp.trashHpAgreement(getAuth(req), params.id, body.reason, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post(
  '/agreements/:id/restore',
  requireOffice,
  validate({ params: idParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    hp.restoreHpAgreement(getAuth(req), params.id, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

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

// A manager letting a counter-signed agreement stand.
hpRouter.post(
  '/agreements/:id/approve',
  requireOffice,
  validate({ params: idParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    hp.approveAgreement(getAuth(req), params.id, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post(
  '/agreements/:id/reject',
  requireOffice,
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

hpRouter.post(
  '/agreements/:id/mark-arrears',
  requireOffice,
  validate({ params: idParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: IdParams }>(req);
    hp.markArrears(getAuth(req), params.id, req.id as string)
      .then((agreement) => res.json({ agreement }))
      .catch(next);
  },
);

hpRouter.post(
  '/agreements/:id/repossess',
  requireOffice,
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
  requireOffice,
  validate({ params: idParams, body: forfeitBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: ForfeitBody }>(req);
    hp.forfeit(getAuth(req), params.id, body.restock, req.id as string)
      .then((result) => res.json(result))
      .catch(next);
  },
);

/**
 * Proof of a payment against an agreement — deposit, instalment or redemption.
 * One endpoint for all three: they are the same document with a different title.
 */
hpRouter.get(
  '/agreements/:id/payments/:paymentId/receipt',
  validate({ params: paymentIdParams }),
  (req, res, next) => {
    const { params } = getValidated<{ params: PaymentIdParams }>(req);
    hp.agreementPaymentReceipt(params.id, params.paymentId)
      .then(({ buffer, filename }) => {
        res.type('application/pdf').attachment(filename).send(buffer);
      })
      .catch(next);
  },
);
