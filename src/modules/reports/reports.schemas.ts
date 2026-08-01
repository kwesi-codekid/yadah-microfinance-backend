import { z } from 'zod';

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
