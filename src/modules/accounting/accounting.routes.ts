import { Router } from 'express';
import { sendExport } from '../../lib/exports.js';
import { getAuth, requireAuth } from '../../middleware/auth.js';
import { requireAdmin, requireOffice } from '../../middleware/rbac.js';
import { getValidated, validate } from '../../middleware/validate.js';
import * as balanceSheet from './balance-sheet.service.js';
import * as cash from './cash.service.js';
import * as assets from './fixed-assets.service.js';
import { balanceSheetPdf, profitAndLossPdf } from './statement-pdf.service.js';
import {
  asOfQuery,
  balanceSheetQuery,
  createCapitalEntryBody,
  createCashAccountBody,
  createFixedAssetBody,
  disposeFixedAssetBody,
  idParams,
  listCapitalQuery,
  listFixedAssetsQuery,
  profitLossQuery,
  type AsOfQuery,
  type BalanceSheetQuery,
  type CreateCapitalEntryBody,
  type CreateCashAccountBody,
  type CreateFixedAssetBody,
  type DisposeFixedAssetBody,
  type IdParams,
  type ListCapitalQuery,
  type ListFixedAssetsQuery,
  type ProfitLossQuery,
} from './accounting.schemas.js';

/**
 * The company's own books: what it spends, what it owns, and where it stands.
 *
 * Office-only throughout. The pieces that define the shape of the accounts —
 * opening balances, capital, and the asset register — are admin-only, because
 * getting them wrong silently changes every statement that reads them.
 */
export const accountingRouter = Router();
accountingRouter.use(requireAuth, requireOffice);

// ---------------------------------------------------------------- cash accounts

accountingRouter.get('/cash-accounts', (_req, res, next) => {
  cash
    .listAccounts()
    .then((accounts) => res.json({ accounts }))
    .catch(next);
});

// An opening balance rewrites where every statement starts from.
accountingRouter.post(
  '/cash-accounts',
  requireAdmin,
  validate({ body: createCashAccountBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: CreateCashAccountBody }>(req);
    cash
      .createAccount(getAuth(req), body, req.id as string)
      .then((account) => res.status(201).json({ account }))
      .catch(next);
  },
);

accountingRouter.get('/cash-position', validate({ query: asOfQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: AsOfQuery }>(req);
  cash
    .cashPosition(query.asOf)
    .then((position) => res.json(position))
    .catch(next);
});

// Expenses used to live here. They moved to their own module at
// /api/v1/expenses when recording was opened to the counter: petty cash is
// spent by whoever is at the counter, and the accounting statements are read
// at month end by somebody else entirely. The balance sheet below still reads
// expensesByCategory and accruedExpenses from that module.

// ---------------------------------------------------------------- fixed assets

accountingRouter.get(
  '/fixed-assets',
  validate({ query: listFixedAssetsQuery }),
  (req, res, next) => {
    const { query } = getValidated<{ query: ListFixedAssetsQuery }>(req);
    assets
      .listAssets(query)
      .then((list) => {
        if (query.format !== 'json') {
          return sendExport(res, {
            format: query.format,
            filename: 'fixed-assets',
            payload: null,
            rows: list.items.map((a) => ({
              name: a.name,
              category: a.category,
              acquiredOn: a.acquiredOn,
              cost: a.cost,
              usefulLifeMonths: a.usefulLifeMonths,
              accumulatedDepreciation: a.depreciation.accumulated,
              netBookValue: a.depreciation.netBookValue,
              status: a.status,
            })),
            moneyKeys: ['cost', 'accumulatedDepreciation', 'netBookValue'],
            sheet: 'Fixed assets',
          });
        }
        res.json(list);
        return undefined;
      })
      .catch(next);
  },
);

accountingRouter.post(
  '/fixed-assets',
  requireAdmin,
  validate({ body: createFixedAssetBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: CreateFixedAssetBody }>(req);
    assets
      .registerAsset(getAuth(req), body, req.id as string)
      .then((asset) => res.status(201).json({ asset }))
      .catch(next);
  },
);

accountingRouter.post(
  '/fixed-assets/:id/dispose',
  requireAdmin,
  validate({ params: idParams, body: disposeFixedAssetBody }),
  (req, res, next) => {
    const { params, body } = getValidated<{ params: IdParams; body: DisposeFixedAssetBody }>(req);
    assets
      .disposeAsset(getAuth(req), params.id, body, req.id as string)
      .then((asset) => res.json({ asset }))
      .catch(next);
  },
);

// ---------------------------------------------------------------- capital

accountingRouter.get('/capital', validate({ query: listCapitalQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ListCapitalQuery }>(req);
  assets
    .listCapital(query)
    .then((list) => res.json(list))
    .catch(next);
});

// Owner's money in and out moves equity, never profit — admin only.
accountingRouter.post(
  '/capital',
  requireAdmin,
  validate({ body: createCapitalEntryBody }),
  (req, res, next) => {
    const { body } = getValidated<{ body: CreateCapitalEntryBody }>(req);
    assets
      .recordCapital(getAuth(req), body, req.id as string)
      .then((entry) => res.status(201).json({ entry }))
      .catch(next);
  },
);

// ---------------------------------------------------------------- statements

accountingRouter.get('/balance-sheet', validate({ query: balanceSheetQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: BalanceSheetQuery }>(req);
  balanceSheet
    .balanceSheet(query.asOf)
    .then(async (sheet) => {
      if (query.format === 'pdf') {
        const { buffer, filename } = await balanceSheetPdf(sheet);
        res.type('application/pdf').attachment(filename).send(buffer);
        return undefined;
      }
      if (query.format !== 'json') {
        return sendExport(res, {
          format: query.format,
          filename: `balance-sheet-${sheet.asOf}`,
          payload: null,
          rows: balanceSheetRows(sheet),
          moneyKeys: ['amount'],
          sheet: 'Balance sheet',
        });
      }
      res.json(sheet);
      return undefined;
    })
    .catch(next);
});

accountingRouter.get('/profit-loss', validate({ query: profitLossQuery }), (req, res, next) => {
  const { query } = getValidated<{ query: ProfitLossQuery }>(req);
  balanceSheet
    .profitAndLoss(query.from, query.to)
    .then(async (pl) => {
      if (query.format === 'pdf') {
        const { buffer, filename } = await profitAndLossPdf(pl);
        res.type('application/pdf').attachment(filename).send(buffer);
        return undefined;
      }
      if (query.format !== 'json') {
        return sendExport(res, {
          format: query.format,
          filename: `profit-loss-${pl.from}-to-${pl.to}`,
          payload: null,
          rows: [
            { section: 'Income', line: 'Susu commission', amount: pl.income.susuCommission },
            { section: 'Income', line: 'Savings fees', amount: pl.income.savingsFees },
            { section: 'Income', line: 'Loan interest', amount: pl.income.loanInterest },
            {
              section: 'Income',
              line: 'Hire purchase interest',
              amount: pl.income.hirePurchaseInterest,
            },
            {
              section: 'Income',
              line: 'Outright sales margin',
              amount: pl.income.outrightSalesProfit,
            },
            { section: 'Income', line: 'Total income', amount: pl.income.total },
            ...pl.expenses.byCategory.map((c) => ({
              section: 'Expenses',
              line: c.category,
              amount: c.amount,
            })),
            { section: 'Expenses', line: 'Depreciation', amount: pl.expenses.depreciation },
            { section: 'Expenses', line: 'Total expenses', amount: pl.expenses.total },
            { section: 'Result', line: 'Net profit', amount: pl.netProfit },
          ],
          moneyKeys: ['amount'],
          sheet: 'Profit and loss',
        });
      }
      res.json(pl);
      return undefined;
    })
    .catch(next);
});

/** Flattens the nested sheet into the line-per-row shape a spreadsheet wants. */
function balanceSheetRows(sheet: balanceSheet.BalanceSheet): Record<string, unknown>[] {
  const { assets: a, liabilities: l, equity: e } = sheet;
  return [
    { section: 'Assets', line: 'Cash and bank', amount: a.current.cashAndBank },
    { section: 'Assets', line: 'Loans receivable', amount: a.current.loansReceivable },
    {
      section: 'Assets',
      line: 'Hire purchase receivable',
      amount: a.current.hirePurchaseReceivable,
    },
    { section: 'Assets', line: 'Inventory at cost', amount: a.current.inventory },
    { section: 'Assets', line: 'Total current assets', amount: a.current.total },
    { section: 'Assets', line: 'Fixed assets at cost', amount: a.nonCurrent.fixedAssetsAtCost },
    {
      section: 'Assets',
      line: 'Less accumulated depreciation',
      amount: -a.nonCurrent.accumulatedDepreciation,
    },
    { section: 'Assets', line: 'Total assets', amount: a.total },
    { section: 'Liabilities', line: 'Susu balances', amount: l.customerDeposits.susuBalances },
    {
      section: 'Liabilities',
      line: 'Savings balances',
      amount: l.customerDeposits.savingsBalances,
    },
    {
      section: 'Liabilities',
      line: 'Susu payouts pending',
      amount: l.customerDeposits.susuPayoutsPending,
    },
    { section: 'Liabilities', line: 'Accrued expenses', amount: l.accruedExpenses },
    { section: 'Liabilities', line: 'Total liabilities', amount: l.total },
    { section: 'Equity', line: 'Contributed capital', amount: e.contributedCapital },
    { section: 'Equity', line: 'Drawings', amount: -e.drawings },
    { section: 'Equity', line: 'Retained earnings', amount: e.retainedEarnings },
    { section: 'Equity', line: 'Total equity', amount: e.total },
    { section: 'Check', line: 'Assets less liabilities and equity', amount: sheet.checkDifference },
  ];
}
