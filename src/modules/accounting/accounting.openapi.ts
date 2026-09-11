import { z } from 'zod';
import type { ZodOpenApiPathsObject } from 'zod-openapi';
import { errorResponse, jsonResponse } from '../../openapi/shared.js';
import {
  asOfQuery,
  balanceSheetQuery,
  createCapitalEntryBody,
  createCashAccountBody,
  createFixedAssetBody,
  disposeFixedAssetBody,
  listFixedAssetsQuery,
  profitLossQuery,
} from './accounting.schemas.js';

const security = [{ bearerAuth: [] }];
const tags = ['Accounting'];
const csvNote = ' Pass format=csv or format=xlsx for a download.';
const pdfNote =
  '\n\n`format=pdf` returns a laid-out A4 statement on Yadah letterhead, ready to print or ' +
  'hand to the client: amounts right-aligned in a GHS column so the digits line up by place ' +
  'value, negatives in parentheses, a rule above each subtotal and a double rule under each ' +
  'section total, and numbered notes to the accounts.';

const money = z.number().int().describe('Integer pesewas');

const balanceSheet = z
  .object({
    asOf: z.string(),
    assets: z.object({
      current: z.object({
        cashAndBank: money,
        loansReceivable: money.describe('Principal outstanding, excluding uncollected interest'),
        hirePurchaseReceivable: money,
        inventory: money.describe('Hire purchase stock at COST, never at selling price'),
        total: money,
      }),
      nonCurrent: z.object({
        fixedAssetsAtCost: money,
        accumulatedDepreciation: money,
        netBookValue: money,
      }),
      total: money,
    }),
    liabilities: z.object({
      customerDeposits: z.object({
        susuBalances: money,
        savingsBalances: money,
        susuPayoutsPending: money,
        total: money,
      }),
      accruedExpenses: money.describe('Incurred but not yet paid'),
      total: money,
    }),
    equity: z.object({
      contributedCapital: money,
      drawings: money,
      retainedEarnings: money,
      total: money,
    }),
    checkDifference: money.describe(
      'assets minus (liabilities + equity). Should be 0; reported rather than hidden.',
    ),
    balances: z.boolean(),
    disclosures: z.object({
      unearnedLoanInterest: money,
      unearnedHpInterest: money,
      note: z.string(),
    }),
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: 'BalanceSheet' });

const profitLoss = z
  .object({
    from: z.string(),
    to: z.string(),
    income: z.object({
      susuCommission: money,
      savingsFees: money,
      outrightSalesProfit: money,
      loanInterest: money.describe('Recognised as repaid, not when the loan was written'),
      hirePurchaseInterest: money,
      total: money,
    }),
    expenses: z.object({
      byCategory: z.array(
        z.object({ category: z.string(), count: z.number().int(), amount: money }),
      ),
      recorded: money,
      depreciation: money.describe('Computed straight-line from the asset register'),
      total: money,
    }),
    netProfit: money,
    generatedAt: z.iso.datetime(),
  })
  .meta({ id: 'ProfitAndLoss' });

export const accountingPaths: ZodOpenApiPathsObject = {
  '/accounting/cash-accounts': {
    get: {
      tags,
      summary: 'The company own cash, bank and mobile money accounts',
      security,
      responses: { '200': jsonResponse('Accounts', z.object({ accounts: z.array(z.unknown()) })) },
    },
    post: {
      tags,
      summary: 'Open a company account with its opening balance (admin)',
      description:
        'The opening balance is where every statement starts counting from — set it once, ' +
        'from a real reconciled figure.\n\n' +
        'At most ONE active account per channel. Customer money is tied to an account by ' +
        'the channel it was recorded on (cash, Paystack, momo), so two accounts sharing a ' +
        'channel would each claim the same transactions and double the cash position.\n\n' +
        '**Record the matching opening capital too** (POST /accounting/capital), or the ' +
        'balance sheet will report a non-zero checkDifference equal to the unmatched ' +
        'opening cash.',
      security,
      requestBody: { content: { 'application/json': { schema: createCashAccountBody } } },
      responses: {
        '201': jsonResponse('Account opened', z.object({ account: z.unknown() })),
        '409': errorResponse('Another active account already takes that channel'),
      },
    },
  },
  '/accounting/cash-position': {
    get: {
      tags,
      summary: 'What each account holds, and the total',
      description:
        'Balances are DERIVED on every read, never stored: opening balance, plus customer ' +
        'money in and out on that channel, plus capital, less expenses paid and assets ' +
        'bought. Nothing keeps a running total, so no missed write can leave a stored ' +
        'balance quietly wrong.',
      security,
      requestParams: { query: asOfQuery },
      responses: { '200': jsonResponse('Cash position', z.unknown()) },
    },
  },
  '/accounting/fixed-assets': {
    get: {
      tags,
      summary: 'The asset register with depreciation as at a date' + csvNote,
      security,
      requestParams: { query: listFixedAssetsQuery },
      responses: { '200': jsonResponse('Assets', z.unknown()) },
    },
    post: {
      tags,
      summary: 'Register an asset (admin)',
      description:
        'A motorbike or computer is an ASSET, not an expense — buying one converts cash ' +
        'into something of equal value. Only the monthly depreciation reaches profit and ' +
        'loss.\n\n' +
        'Depreciation is straight-line and COMPUTED from cost, salvage value and useful ' +
        'life, never posted monthly: there is no scheduled run to miss and no backfill ' +
        'after downtime.',
      security,
      requestBody: { content: { 'application/json': { schema: createFixedAssetBody } } },
      responses: {
        '201': jsonResponse('Registered', z.object({ asset: z.unknown() })),
        '422': errorResponse('Salvage value is not less than cost'),
      },
    },
  },
  '/accounting/fixed-assets/{id}/dispose': {
    post: {
      tags,
      summary: 'Dispose of an asset (admin)',
      description:
        'Removes it from the balance sheet from that day. Any proceeds are money back IN, ' +
        'never a negative expense.',
      security,
      requestBody: { content: { 'application/json': { schema: disposeFixedAssetBody } } },
      responses: { '200': jsonResponse('Disposed', z.object({ asset: z.unknown() })) },
    },
  },
  '/accounting/capital': {
    get: {
      tags,
      summary: 'Owner contributions and drawings',
      security,
      responses: { '200': jsonResponse('Capital entries', z.unknown()) },
    },
    post: {
      tags,
      summary: 'Record owner money in or out (admin)',
      description:
        'A contribution is the owner putting money in; a drawing is taking it out. Neither ' +
        'is income or an expense — they move EQUITY, not profit, which is exactly why they ' +
        'cannot be recorded as expenses.\n\n' +
        'The opening capital at go-live is simply the first contribution.',
      security,
      requestBody: { content: { 'application/json': { schema: createCapitalEntryBody } } },
      responses: { '201': jsonResponse('Recorded', z.object({ entry: z.unknown() })) },
    },
  },
  '/accounting/balance-sheet': {
    get: {
      tags,
      summary: 'What the business owns, owes, and is worth on one day' + csvNote + pdfNote,
      description:
        'Two things worth stating plainly:\n\n' +
        '- **Customer deposits are LIABILITIES.** Susu and savings balances are money held ' +
        'on someone else behalf and repayable. A microfinance that reads its deposit ' +
        'book as wealth is the classic way to go under.\n' +
        '- **Loans receivable is shown at principal outstanding.** Interest is recognised ' +
        'as it is repaid, so uncollected interest is disclosed separately rather than ' +
        'counted as an asset.\n\n' +
        '`checkDifference` is assets minus (liabilities + equity) and should be 0. It is ' +
        'REPORTED rather than hidden: a non-zero figure means the derived cash position ' +
        'and the recorded books have drifted, and you need to see that rather than read a ' +
        'sheet forced to balance. The usual cause is opening cash without matching opening ' +
        'capital.',
      security,
      requestParams: { query: balanceSheetQuery },
      responses: { '200': jsonResponse('Balance sheet', balanceSheet) },
    },
  },
  '/accounting/profit-loss': {
    get: {
      tags,
      summary: 'Income and expenses over a period' + csvNote + pdfNote,
      description:
        'Income is susu commission, savings fees, outright-sale margin, and loan and hire ' +
        'purchase interest recognised as repaid. Expenses are the recorded categories plus ' +
        'computed depreciation.\n\n' +
        'Defaults to the current Accra month. Retained earnings on the balance sheet are ' +
        'built from these same components over all time, so the two statements can never ' +
        'disagree.',
      security,
      requestParams: { query: profitLossQuery },
      responses: { '200': jsonResponse('Profit and loss', profitLoss) },
    },
  },
};
