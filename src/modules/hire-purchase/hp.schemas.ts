import { z } from 'zod';
import {
  channel,
  dateRangeFields,
  exportFormat,
  fromToIssue,
  ghanaPhone,
  idempotencyKey,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';

// ---- items

export const createItemBody = z
  .object({
    name: z.string().min(2).max(120).trim(),
    description: z.string().min(2).max(500).trim().optional(),
    quantityInStock: z.number().int().min(0),
    costPrice: positiveMoneyPesewas,
    sellingPrice: positiveMoneyPesewas,
  })
  .check((ctx) => {
    if (ctx.value.sellingPrice < ctx.value.costPrice) {
      ctx.issues.push({
        code: 'custom',
        message: 'sellingPrice must be at least costPrice (duplicate the amount if equal)',
        path: ['sellingPrice'],
        input: ctx.value.sellingPrice,
      });
    }
  });
export type CreateItemBody = z.infer<typeof createItemBody>;

export const updateItemBody = z
  .object({
    name: z.string().min(2).max(120).trim().optional(),
    description: z.string().min(2).max(500).trim().optional(),
    costPrice: positiveMoneyPesewas.optional(),
    sellingPrice: positiveMoneyPesewas.optional(),
    status: z.enum(['active', 'discontinued']).optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateItemBody = z.infer<typeof updateItemBody>;

export const adjustStockBody = z.object({
  /** Positive = stock received, negative = correction/write-off. */
  delta: z
    .number()
    .int()
    .min(-1000)
    .max(1000)
    .refine((v) => v !== 0, 'delta cannot be zero'),
  reason: z.string().min(2).max(200).trim(),
});
export type AdjustStockBody = z.infer<typeof adjustStockBody>;

export const listItemsQuery = pagination
  .extend({
    status: z.enum(['active', 'discontinued']).optional(),
    search: z.string().min(1).max(100).optional(),
    inStockOnly: z.coerce.boolean().default(false),
    format: exportFormat,
    ...dateRangeFields,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListItemsQuery = z.infer<typeof listItemsQuery>;

// ---- config

export const putConfigBody = z.object({
  interestRatePercent: z.number().int().min(0).max(100),
});
export type PutConfigBody = z.infer<typeof putConfigBody>;

// ---- agreements

export const createAgreementBody = z.object({
  customerId: objectId,
  itemId: objectId,
  durationMonths: z.number().int().min(1).max(24),
});
export type CreateAgreementBody = z.infer<typeof createAgreementBody>;

export const depositBody = z.object({
  /** Must equal the agreement's depositRequired exactly. */
  amount: positiveMoneyPesewas,
  idempotencyKey,
  channel,
});
export type DepositBody = z.infer<typeof depositBody>;

export const reasonBody = z.object({
  reason: z.string().min(2).max(300).trim(),
});
export type ReasonBody = z.infer<typeof reasonBody>;

export const paymentBody = z.object({
  amount: positiveMoneyPesewas.min(1),
  idempotencyKey,
  channel,
});
export type PaymentBody = z.infer<typeof paymentBody>;

export const redeemBody = z.object({
  /** Amount is computed server-side: the FULL remaining balance. */
  idempotencyKey,
  channel,
});
export type RedeemBody = z.infer<typeof redeemBody>;

export const forfeitBody = z
  .object({
    /** Put the item back on the shelf as used, at a new office-set price. */
    restock: z
      .object({
        name: z.string().min(2).max(120).trim().optional(),
        description: z.string().min(2).max(500).trim().optional(),
        costPrice: positiveMoneyPesewas,
        sellingPrice: positiveMoneyPesewas,
      })
      .optional(),
  })
  .check((ctx) => {
    const r = ctx.value.restock;
    if (r && r.sellingPrice < r.costPrice) {
      ctx.issues.push({
        code: 'custom',
        message: 'sellingPrice must be at least costPrice',
        path: ['restock', 'sellingPrice'],
        input: r.sellingPrice,
      });
    }
  });
export type ForfeitBody = z.infer<typeof forfeitBody>;

export const listAgreementsQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z
      .enum([
        'awaiting-approval',
        'pending',
        'rejected',
        'active',
        'in-arrears',
        'repossessed',
        'closed-redeemed',
        'closed-forfeited',
        'closed-completed',
      ])
      .optional(),
    search: z.string().min(1).max(100).optional(),
    format: exportFormat,
    ...dateRangeFields,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListAgreementsQuery = z.infer<typeof listAgreementsQuery>;

// ---- outright sales (counter / POS)

/**
 * One basket line. `unitPrice` is optional and defaults to the item's current
 * selling price — pass it only to record a haggled or discounted price, which
 * is then visible against the list price on the sale.
 */
const saleLineBody = z.object({
  itemId: objectId,
  quantity: z.number().int().min(1).max(1000),
  unitPrice: positiveMoneyPesewas.optional(),
});

export const recordSaleBody = z
  .object({
    /** Set when the buyer is a registered customer. Walk-ins leave it out. */
    customerId: objectId.optional(),
    /** Required for a walk-in; ignored when customerId is given (the customer
     *  record is the source of truth for their name). */
    buyerName: z.string().min(2).max(120).trim().optional(),
    buyerPhone: ghanaPhone.optional(),
    lines: z.array(saleLineBody).min(1).max(50),
    idempotencyKey,
    channel,
  })
  .check((ctx) => {
    if (ctx.value.customerId === undefined && ctx.value.buyerName === undefined) {
      ctx.issues.push({
        code: 'custom',
        message: 'Give either a customerId or a buyerName for a walk-in',
        path: ['buyerName'],
        input: ctx.value.buyerName,
      });
    }
    const seen = new Set<string>();
    for (const [index, line] of ctx.value.lines.entries()) {
      const key = line.itemId.toHexString();
      if (seen.has(key)) {
        ctx.issues.push({
          code: 'custom',
          message: 'The same item appears twice — combine it into one line with a quantity',
          path: ['lines', String(index), 'itemId'],
          input: line.itemId,
        });
      }
      seen.add(key);
    }
  });
export type RecordSaleBody = z.infer<typeof recordSaleBody>;

export const voidSaleBody = z.object({
  reason: z.string().min(2).max(300).trim(),
});
export type VoidSaleBody = z.infer<typeof voidSaleBody>;

export const listSalesQuery = pagination
  .extend({
    customerId: objectId.optional(),
    status: z.enum(['completed', 'voided']).optional(),
    /** Fuzzy-free: matches the buyer name recorded on the sale. */
    search: z.string().min(1).max(100).optional(),
    /** Walk-in sales only (no registered customer behind them). */
    walkInOnly: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    format: exportFormat,
    ...dateRangeFields,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListSalesQuery = z.infer<typeof listSalesQuery>;

// ---- trash

export { trashBody, type TrashBody } from '../../schemas/common.js';

export const trashListQuery = pagination;
export type TrashListQuery = z.infer<typeof trashListQuery>;

export const idParams = z.object({ id: objectId });

export const paymentIdParams = z.object({ id: objectId, paymentId: objectId });
export type PaymentIdParams = z.infer<typeof paymentIdParams>;
export type IdParams = z.infer<typeof idParams>;

export const customerIdParams = z.object({ customerId: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;
