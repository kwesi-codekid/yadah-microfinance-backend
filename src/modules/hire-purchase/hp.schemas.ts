import { z } from 'zod';
import {
  channel,
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

export const listItemsQuery = pagination.extend({
  status: z.enum(['active', 'discontinued']).optional(),
  search: z.string().min(1).max(100).optional(),
  inStockOnly: z.coerce.boolean().default(false),
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

export const listAgreementsQuery = pagination.extend({
  customerId: objectId.optional(),
  status: z
    .enum([
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
});
export type ListAgreementsQuery = z.infer<typeof listAgreementsQuery>;

export const idParams = z.object({ id: objectId });
export type IdParams = z.infer<typeof idParams>;

export const customerIdParams = z.object({ customerId: objectId });
export type CustomerIdParams = z.infer<typeof customerIdParams>;
