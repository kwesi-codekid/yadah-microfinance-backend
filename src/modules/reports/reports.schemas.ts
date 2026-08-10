import { z } from 'zod';
import { TXN_MODULES } from '../../domain/transactions.js';
import { objectId, pagination } from '../../schemas/common.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/** Accra-day range, inclusive on both ends. Defaults to the last 30 days. */
export const rangeQuery = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .check((ctx) => {
    if (ctx.value.from && ctx.value.to && ctx.value.from > ctx.value.to) {
      ctx.issues.push({
        code: 'custom',
        message: 'from must not be after to',
        path: ['from'],
        input: ctx.value.from,
      });
    }
  });
export type RangeQuery = z.infer<typeof rangeQuery>;

export const formatOnlyQuery = z.object({
  format: z.enum(['json', 'csv']).default('json'),
});
export type FormatOnlyQuery = z.infer<typeof formatOnlyQuery>;

/** Unified transaction feed: Accra-day range + pagination + optional filters. */
export const transactionsQuery = pagination
  .extend({
    from: isoDay.optional(),
    to: isoDay.optional(),
    module: z.enum(TXN_MODULES).optional(),
    customerId: objectId.optional(),
    format: z.enum(['json', 'csv']).default('json'),
  })
  .check((ctx) => {
    if (ctx.value.from && ctx.value.to && ctx.value.from > ctx.value.to) {
      ctx.issues.push({
        code: 'custom',
        message: 'from must not be after to',
        path: ['from'],
        input: ctx.value.from,
      });
    }
  });
export type TransactionsQuery = z.infer<typeof transactionsQuery>;
