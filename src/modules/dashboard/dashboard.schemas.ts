import { z } from 'zod';
import { accraDay } from '../../lib/time.js';
import { fromToIssue, isoDay } from '../../schemas/common.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How far back each bucket size looks when the caller gives no range. Chosen
 * so the default call returns a chart-shaped window: a year of months, a
 * quarter of weeks, a month of days.
 */
const DEFAULT_SPAN_DAYS = { day: 30, week: 84, month: 365 } as const;

function daysAgo(days: number): string {
  return accraDay(new Date(Date.now() - days * DAY_MS));
}

/**
 * Bucketed cash series. `from`/`to` are optional — omitting them gives the
 * default span for the chosen bucket, so the charts work with no parameters.
 */
export const seriesQuery = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    bucket: z.enum(['day', 'week', 'month']).default('day'),
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push({ ...issue, input: ctx.value.from });
  })
  .transform((v) => {
    const to = v.to ?? accraDay();
    const from = v.from ?? daysAgo(DEFAULT_SPAN_DAYS[v.bucket]);
    return { from, to, bucket: v.bucket };
  });
export type SeriesQuery = z.infer<typeof seriesQuery>;

/** Range for the efficiency gauge. Defaults to the last 30 days. */
export const efficiencyQuery = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push({ ...issue, input: ctx.value.from });
  })
  .transform((v) => ({ from: v.from ?? daysAgo(30), to: v.to ?? accraDay() }));
export type EfficiencyQuery = z.infer<typeof efficiencyQuery>;

/**
 * The recent-activity table. Short by design — this is a dashboard panel, not
 * the transaction report; deeper paging belongs on /reports/transactions.
 */
export const recentQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  includePending: z
    .enum(['true', 'false'])
    .default('true')
    .transform((v) => v === 'true'),
});
export type RecentQuery = z.infer<typeof recentQuery>;
