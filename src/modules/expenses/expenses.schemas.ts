import { z } from 'zod';
import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '../../models/index.js';
import {
  dateRangeFields,
  exportFormat,
  fromToIssue,
  objectId,
  pagination,
  positiveMoneyPesewas,
  uploadedImageUrl,
} from '../../schemas/common.js';

const isoDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const createExpenseBody = z.object({
  category: z.enum(EXPENSE_CATEGORIES),
  description: z.string().min(3).max(300).trim(),
  amount: positiveMoneyPesewas,
  payee: z.string().min(2).max(160).trim().optional(),
  /** The day the COST belongs to — August salaries paid in September are August. */
  incurredOn: isoDay,
  /**
   * A photograph of the receipt or invoice.
   *
   * Deliberately a plain URL rather than the Cloudinary-only `uploadedImageUrl`
   * used elsewhere: most receipts are snapped through our own uploader, but a
   * supplier's hosted invoice link is a perfectly good record of a cost and
   * refusing it would push people into not attaching anything at all.
   */
  receiptUrl: z.url().optional(),
  reference: z.string().max(80).trim().optional(),
  writeOffEntityType: z.enum(['loan', 'hp-agreement']).optional(),
  writeOffEntityId: objectId.optional(),
});
export type CreateExpenseBody = z.infer<typeof createExpenseBody>;

export const updateExpenseBody = createExpenseBody.partial();
export type UpdateExpenseBody = z.infer<typeof updateExpenseBody>;

/** Attaching a photo after the fact goes through our own uploader only. */
export const attachReceiptBody = z.object({
  receiptUrl: uploadedImageUrl,
});
export type AttachReceiptBody = z.infer<typeof attachReceiptBody>;

export const rejectExpenseBody = z.object({
  reason: z.string().min(3).max(300).trim(),
});
export type RejectExpenseBody = z.infer<typeof rejectExpenseBody>;

/** Paying is what actually moves money, so it names the account explicitly. */
export const payExpenseBody = z.object({
  cashAccountId: objectId,
  paidOn: isoDay.optional(),
});
export type PayExpenseBody = z.infer<typeof payExpenseBody>;

export const listExpensesQuery = pagination
  .extend({
    category: z.enum(EXPENSE_CATEGORIES).optional(),
    status: z.enum(EXPENSE_STATUSES).optional(),
    cashAccountId: objectId.optional(),
    search: z.string().min(1).max(100).optional(),
    ...dateRangeFields,
    format: exportFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ListExpensesQuery = z.infer<typeof listExpensesQuery>;

export const expenseSummaryQuery = z.object({ ...dateRangeFields }).check((ctx) => {
  const issue = fromToIssue(ctx.value);
  if (issue) ctx.issues.push(issue);
});
export type ExpenseSummaryQuery = z.infer<typeof expenseSummaryQuery>;

export const expenseIdParams = z.object({ id: objectId });
export type ExpenseIdParams = z.infer<typeof expenseIdParams>;

export const trashListQuery = pagination;
export type TrashListQuery = z.infer<typeof trashListQuery>;
