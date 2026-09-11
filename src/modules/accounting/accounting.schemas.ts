import { z } from 'zod';
import {
  CAPITAL_ENTRY_KINDS,
  CASH_ACCOUNT_KINDS,
  FIXED_ASSET_CATEGORIES,
} from '../../models/index.js';
import {
  dateRangeFields,
  exportFormat,
  fromToIssue,
  isoDay,
  moneyPesewas,
  objectId,
  pagination,
  positiveMoneyPesewas,
} from '../../schemas/common.js';

export const idParams = z.object({ id: objectId });
export type IdParams = z.infer<typeof idParams>;

// ---------------------------------------------------------------- cash accounts

export const createCashAccountBody = z.object({
  name: z.string().min(2).max(120).trim(),
  kind: z.enum(CASH_ACCOUNT_KINDS),
  /** At most one active account per channel — enforced in the service. */
  channel: z.enum(['cash', 'paystack', 'momo']),
  openingBalance: moneyPesewas,
  openingDate: isoDay,
  bankName: z.string().min(2).max(120).trim().optional(),
  accountNumber: z.string().min(2).max(40).trim().optional(),
});
export type CreateCashAccountBody = z.infer<typeof createCashAccountBody>;

export const asOfQuery = z.object({ asOf: isoDay.optional() });
export type AsOfQuery = z.infer<typeof asOfQuery>;

// ---------------------------------------------------------------- expenses

// Expense schemas moved with the module, to src/modules/expenses/.

// ---------------------------------------------------------------- fixed assets

export const createFixedAssetBody = z.object({
  name: z.string().min(2).max(160).trim(),
  category: z.enum(FIXED_ASSET_CATEGORIES),
  cost: positiveMoneyPesewas,
  acquiredOn: isoDay,
  usefulLifeMonths: z.number().int().min(1).max(600),
  salvageValue: moneyPesewas.default(0),
  cashAccountId: objectId.optional(),
  serialNumber: z.string().max(80).trim().optional(),
  assignedToId: objectId.optional(),
});
export type CreateFixedAssetBody = z.infer<typeof createFixedAssetBody>;

export const disposeFixedAssetBody = z.object({
  disposedOn: isoDay.optional(),
  /** Cash received, if any. Money back IN, never a negative expense. */
  disposalProceeds: moneyPesewas.default(0),
  cashAccountId: objectId.optional(),
  note: z.string().max(300).trim().optional(),
});
export type DisposeFixedAssetBody = z.infer<typeof disposeFixedAssetBody>;

export const listFixedAssetsQuery = pagination.extend({
  category: z.enum(FIXED_ASSET_CATEGORIES).optional(),
  status: z.enum(['active', 'disposed']).optional(),
  asOf: isoDay.optional(),
  format: exportFormat,
});
export type ListFixedAssetsQuery = z.infer<typeof listFixedAssetsQuery>;

// ---------------------------------------------------------------- capital

export const createCapitalEntryBody = z.object({
  kind: z.enum(CAPITAL_ENTRY_KINDS),
  amount: positiveMoneyPesewas,
  occurredOn: isoDay,
  cashAccountId: objectId.optional(),
  note: z.string().max(300).trim().optional(),
});
export type CreateCapitalEntryBody = z.infer<typeof createCapitalEntryBody>;

export const listCapitalQuery = pagination.extend({
  kind: z.enum(CAPITAL_ENTRY_KINDS).optional(),
  ...dateRangeFields,
});
export type ListCapitalQuery = z.infer<typeof listCapitalQuery>;

// ---------------------------------------------------------------- statements

/**
 * Statements add `pdf` to the usual export formats. Only these two support it:
 * a PDF is a laid-out document, and there is nothing to lay out for a raw
 * listing.
 */
const statementFormat = z.enum(['json', 'csv', 'xlsx', 'pdf']).default('json');

/** A balance sheet is a position on ONE day, not over a range. */
export const balanceSheetQuery = z.object({
  asOf: isoDay.optional(),
  format: statementFormat,
});
export type BalanceSheetQuery = z.infer<typeof balanceSheetQuery>;

/** Profit and loss covers a period. Defaults to the current Accra month. */
export const profitLossQuery = z
  .object({
    from: isoDay.optional(),
    to: isoDay.optional(),
    format: statementFormat,
  })
  .check((ctx) => {
    const issue = fromToIssue(ctx.value);
    if (issue) ctx.issues.push(issue);
  });
export type ProfitLossQuery = z.infer<typeof profitLossQuery>;
