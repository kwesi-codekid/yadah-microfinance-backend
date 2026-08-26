import { z } from 'zod';
import {
  dateRangeFields,
  exportFormat,
  fromToIssue,
  isoDay,
  moneyPesewas,
  objectId,
  pagination,
} from '../../schemas/common.js';

/**
 * A collector declares the physical cash counted at the end of their round;
 * the office receiver then confirms what was actually turned in. Both amounts
 * may be zero — a day with no collections still closes cleanly.
 */
export const declareDayBody = z.object({
  /** Defaults to today (Accra). Backdating is allowed for a late close. */
  accraDay: isoDay.optional(),
  /** Physical cash counted in hand, in pesewas. */
  declaredAmount: moneyPesewas,
  declaredNote: z.string().min(2).max(300).trim().optional(),
});
export type DeclareDayBody = z.infer<typeof declareDayBody>;

export const confirmDayBody = z.object({
  /** What the receiver actually counted in, in pesewas. */
  receivedAmount: moneyPesewas,
  /** Required when the money does not match what the system expected. */
  varianceReason: z.string().min(2).max(300).trim().optional(),
});
export type ConfirmDayBody = z.infer<typeof confirmDayBody>;

export const listReconciliationsQuery = pagination
  .extend({
    /** Office filter. Ignored for collectors — they only ever see their own. */
    collectorId: objectId.optional(),
    status: z.enum(['declared', 'reconciled']).optional(),
    /** Only days where the money did not match. */
    varianceOnly: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .optional(),
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListReconciliationsQuery = z.infer<typeof listReconciliationsQuery>;

export const reconciliationIdParams = z.object({ id: objectId });
export type ReconciliationIdParams = z.infer<typeof reconciliationIdParams>;

/** What the system expects for a collector's day, before they declare. */
export const expectedQuery = z.object({
  accraDay: isoDay.optional(),
  /** Office roles may preview any collector; collectors are pinned to themselves. */
  collectorId: objectId.optional(),
});
export type ExpectedQuery = z.infer<typeof expectedQuery>;

export const varianceReportQuery = z
  .object({
    ...dateRangeFields,
    collectorId: objectId.optional(),
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type VarianceReportQuery = z.infer<typeof varianceReportQuery>;
