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
  uploadedImageUrl,
} from '../../schemas/common.js';

// ---- items

export const createItemBody = z
  .object({
    name: z.string().min(2).max(120).trim(),
    /** A brand from GET /hire-purchase/brands. */
    brandId: objectId.optional(),
    /** A category from GET /hire-purchase/categories. */
    categoryId: objectId.optional(),
    description: z.string().min(2).max(500).trim().optional(),
    /** A picture of the item — from POST /uploads/images. */
    imageUrl: uploadedImageUrl.optional(),
    quantityInStock: z.number().int().min(0),
    costPrice: positiveMoneyPesewas,
    sellingPrice: positiveMoneyPesewas,
    /** Defaults to new. A sheet of second-hand stock says `used` per row. */
    condition: z.enum(['new', 'used']).optional(),
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
    /** Null takes the item off a label; a wrong brand is worse than none. */
    brandId: objectId.nullable().optional(),
    categoryId: objectId.nullable().optional(),
    description: z.string().min(2).max(500).trim().optional(),
    /** Null takes the picture off. */
    imageUrl: uploadedImageUrl.nullable().optional(),
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
    brandId: objectId.optional(),
    categoryId: objectId.optional(),
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

// ---- brands and categories

/** One managed label: a name, and a line about it if a name is not enough. */
export const labelBody = z.object({
  name: z.string().min(1).max(60).trim(),
  description: z.string().min(2).max(300).trim().optional(),
});
export type LabelBody = z.infer<typeof labelBody>;

export const updateLabelBody = z
  .object({
    name: z.string().min(1).max(60).trim().optional(),
    /** Null clears it. */
    description: z.string().min(2).max(300).trim().nullable().optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateLabelBody = z.infer<typeof updateLabelBody>;

export const listLabelsQuery = pagination.extend({
  search: z.string().min(1).max(60).optional(),
});
export type ListLabelsQuery = z.infer<typeof listLabelsQuery>;

// ---- receiving stock and price history

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const receiveStockBody = z.object({
  /** How many units arrived. */
  quantity: z.number().int().min(1).max(10_000),
  /**
   * What this delivery cost per unit, from the invoice — in pesewas. Always
   * asked for: the invoice is the only place the real figure exists, and if it
   * disagrees with the shelf the shelf moves and the move is recorded.
   */
  unitCost: positiveMoneyPesewas,
  /** Only when the delivery is also a repricing. Omit to leave it alone. */
  sellingPrice: positiveMoneyPesewas.optional(),
  supplier: z.string().min(2).max(160).trim().optional(),
  invoiceRef: z.string().min(1).max(80).trim().optional(),
  /** The Accra day the goods arrived. Defaults to today; may not be in the future. */
  receivedOn: isoDay.optional(),
  note: z.string().min(2).max(300).trim().optional(),
});
export type ReceiveStockBody = z.infer<typeof receiveStockBody>;

export const listPriceChangesQuery = pagination.extend({
  kind: z.enum(['cost', 'selling']).optional(),
});
export type ListPriceChangesQuery = z.infer<typeof listPriceChangesQuery>;

// ---- damages

const DAMAGE_CAUSE_VALUES = [
  'delivery',
  'in-shop',
  'storage',
  'defective',
  'missing',
  'other',
] as const;

export const reportDamageBody = z.object({
  itemId: objectId,
  quantity: z.number().int().min(1).max(10_000),
  cause: z.enum(DAMAGE_CAUSE_VALUES),
  /** What happened. This is what the office reads when deciding. */
  description: z.string().min(2).max(300).trim(),
  /** The Accra day it happened. Defaults to today. */
  occurredOn: isoDay.optional(),
  /** Photographs of the damage, from the shared uploader. */
  photoUrls: z.array(uploadedImageUrl).max(5).optional(),
});
export type ReportDamageBody = z.infer<typeof reportDamageBody>;

export const updateDamageBody = z
  .object({
    quantity: z.number().int().min(1).max(10_000).optional(),
    cause: z.enum(DAMAGE_CAUSE_VALUES).optional(),
    description: z.string().min(2).max(300).trim().optional(),
    occurredOn: isoDay.optional(),
    photoUrls: z.array(uploadedImageUrl).max(5).optional(),
  })
  .refine((v) => Object.values(v).some((f) => f !== undefined), {
    message: 'At least one field must be provided',
  });
export type UpdateDamageBody = z.infer<typeof updateDamageBody>;

export const rejectDamageBody = z.object({
  /** Why it was refused — the reporter sees this, so it has to say something. */
  reason: z.string().min(2).max(300).trim(),
});
export type RejectDamageBody = z.infer<typeof rejectDamageBody>;

export const listDamagesQuery = pagination
  .extend({
    status: z.enum(['pending', 'approved', 'rejected']).optional(),
    cause: z.enum(DAMAGE_CAUSE_VALUES).optional(),
    itemId: objectId.optional(),
    search: z.string().min(1).max(100).optional(),
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListDamagesQuery = z.infer<typeof listDamagesQuery>;

export const rangeOnlyQuery = z.object({ ...dateRangeFields }).check((ctx) => {
  const issue = fromToIssue(ctx.value);
  if (issue) ctx.issues.push(issue);
});
export type RangeOnlyQuery = z.infer<typeof rangeOnlyQuery>;

/**
 * The corrected sheet coming back from the import preview. Cells stay strings
 * — the counter edits text, and the server decides what it means, so a bad
 * cell is reported against its column instead of rejecting the request.
 */
export const importItemRowsBody = z.object({
  rows: z
    .array(
      z.object({
        row: z.number().int().min(1).optional(),
        values: z.record(z.string(), z.string()),
      }),
    )
    .min(1, 'No rows were sent'),
});
export type ImportItemRowsBody = z.infer<typeof importItemRowsBody>;
export type ImportItemRowInput = ImportItemRowsBody['rows'][number];

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
  /**
   * What the customer actually agreed to pay for the item, in pesewas.
   *
   * Required, and entered every time — the counter types the figure they
   * settled on, which is often just the listed price again. It may be above or
   * below what the shelf lists, and it is what the deposit, the financed half,
   * the interest and every instalment are worked out from.
   */
  agreedPrice: positiveMoneyPesewas.min(2, 'The agreed price is too small to split in half'),
  /** A picture of the customer's signature on the agreement, from POST /uploads/images?kind=signature. */
  signatureUrl: uploadedImageUrl,
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
 * One basket line. `unitPrice` is what the counter and the buyer settled on,
 * and it is the price the sale is written at. It may sit below the shelf price
 * or above it — bargaining runs both ways — and it is optional only so that a
 * basket sold at the shelf price need not repeat it.
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
