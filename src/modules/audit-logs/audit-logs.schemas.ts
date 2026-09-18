import { z } from 'zod';
import {
  dateRangeFields,
  exportFormat,
  fromToIssue,
  objectId,
  pagination,
} from '../../schemas/common.js';

/**
 * One dot-notation action, or the prefix of a family of them: `susu` reaches
 * every susu action, `susu.deposit` the deposit ones, `susu.deposit.record`
 * exactly that one. Several may be given comma-separated, because one area of
 * the business is sometimes written under more than one prefix — the
 * company's own books are `cash-account`, `fixed-asset` and `capital-entry`.
 */
const ACTION_PREFIX = /^[a-z][a-z-]*(\.[a-z][a-z-]*)*$/;

export const actionPrefixes = z
  .string()
  .max(300)
  .transform((raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  )
  .refine((list) => list.length > 0, 'Name at least one action')
  .refine(
    (list) => list.every((s) => ACTION_PREFIX.test(s)),
    'Actions look like susu.deposit.record — lower-case words joined by dots',
  );

export const listAuditLogsQuery = pagination
  .extend({
    actorId: objectId.optional(),
    /** Kebab-case, as the writers record it: `susu-account`, `customer`. */
    entityType: z
      .string()
      .min(2)
      .max(40)
      .regex(/^[a-z][a-z-]*$/, 'Entity types are kebab-case words')
      .optional(),
    entityId: objectId.optional(),
    action: actionPrefixes.optional(),
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuery>;
