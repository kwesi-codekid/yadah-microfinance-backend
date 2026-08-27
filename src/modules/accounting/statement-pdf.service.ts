import { formatGhs } from '../../lib/money.js';
import { buildStatementPdf, type StatementLine } from '../../lib/statement-pdf.js';
import type { BalanceSheet, ProfitAndLoss } from './balance-sheet.service.js';

/**
 * Turns the accounting payloads into printable statements.
 *
 * Nothing is computed here — every figure comes straight from the service that
 * owns it, so a printed statement can never disagree with the JSON the screen
 * showed. This file only decides layout and wording.
 */

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/** '2026-08-27' → '27 August 2026'. */
function longDate(isoDay: string): string {
  const [year, month, day] = isoDay.split('-') as [string, string, string];
  return `${String(Number(day))} ${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** Expense category slugs are for the API; a printed statement needs prose. */
const CATEGORY_LABELS: Record<string, string> = {
  'salaries-staff': 'Salaries and staff costs',
  'petty-cash-office': 'Petty cash and office',
  'utilities-premises': 'Utilities and premises',
  'fees-transport-other': 'Fees, transport and other',
  'bad-debt-recovery': 'Bad debt and recovery',
  'professional-compliance-tax': 'Professional, compliance and tax',
  marketing: 'Marketing',
  insurance: 'Insurance',
};

function categoryLabel(slug: string): string {
  return CATEGORY_LABELS[slug] ?? slug;
}

export interface StatementFile {
  buffer: Buffer;
  filename: string;
}

export async function balanceSheetPdf(sheet: BalanceSheet): Promise<StatementFile> {
  const { assets, liabilities, equity } = sheet;

  const assetLines: StatementLine[] = [
    { label: 'Current assets' },
    { label: 'Cash and bank', amount: assets.current.cashAndBank, indent: 1 },
    { label: 'Loans receivable', amount: assets.current.loansReceivable, indent: 1 },
    {
      label: 'Hire purchase receivable',
      amount: assets.current.hirePurchaseReceivable,
      indent: 1,
    },
    { label: 'Inventory, at cost', amount: assets.current.inventory, indent: 1 },
    { label: 'Total current assets', amount: assets.current.total, subtotal: true },
    { label: 'Non-current assets' },
    { label: 'Fixed assets, at cost', amount: assets.nonCurrent.fixedAssetsAtCost, indent: 1 },
    {
      label: 'Less: accumulated depreciation',
      // Shown negative so it reads as a deduction, in parentheses on the page.
      amount: -assets.nonCurrent.accumulatedDepreciation,
      indent: 1,
    },
    { label: 'Net book value', amount: assets.nonCurrent.netBookValue, subtotal: true },
    { label: 'TOTAL ASSETS', amount: assets.total, total: true },
  ];

  const liabilityLines: StatementLine[] = [
    { label: 'Customer deposits held' },
    { label: 'Susu balances', amount: liabilities.customerDeposits.susuBalances, indent: 1 },
    { label: 'Savings balances', amount: liabilities.customerDeposits.savingsBalances, indent: 1 },
    {
      label: 'Susu payouts pending',
      amount: liabilities.customerDeposits.susuPayoutsPending,
      indent: 1,
    },
    {
      label: 'Total customer deposits',
      amount: liabilities.customerDeposits.total,
      subtotal: true,
    },
    { label: 'Accrued expenses', amount: liabilities.accruedExpenses },
    { label: 'TOTAL LIABILITIES', amount: liabilities.total, total: true },
  ];

  const equityLines: StatementLine[] = [
    { label: 'Contributed capital', amount: equity.contributedCapital },
    { label: 'Less: drawings', amount: -equity.drawings },
    { label: 'Retained earnings', amount: equity.retainedEarnings },
    { label: 'TOTAL EQUITY', amount: equity.total, total: true },
  ];

  const notes = [
    // Plain ASCII only in rendered strings: pdfkit's built-in Helvetica drops
    // typographic apostrophes and dashes, leaving a gap on the page.
    'Customer deposits are liabilities, not assets: susu and savings balances are money ' +
      'held for customers and repayable to them.',
    sheet.disclosures.note,
    `Interest not yet collected and therefore not recognised: ${formatNote(
      sheet.disclosures.unearnedLoanInterest,
    )} on loans and ${formatNote(sheet.disclosures.unearnedHpInterest)} on hire purchase.`,
    'Fixed assets are depreciated straight-line over their useful life.',
    'All amounts are Ghana cedis.',
  ];

  const buffer = await buildStatementPdf({
    title: 'BALANCE SHEET',
    periodLabel: `As at ${longDate(sheet.asOf)}`,
    sections: [
      { heading: 'Assets', lines: assetLines },
      { heading: 'Liabilities', lines: liabilityLines },
      { heading: 'Equity', lines: equityLines },
    ],
    highlight: sheet.balances
      ? {
          label: 'Balance check',
          amount: 0,
          caption: 'Assets equal liabilities plus equity. The statement balances.',
        }
      : {
          label: 'Balance check - does not balance',
          amount: sheet.checkDifference,
          caption:
            'Assets less liabilities and equity should be nil. A difference usually means ' +
            'opening cash was recorded without matching opening capital. This figure is ' +
            'shown rather than hidden.',
          alert: true,
        },
    notes,
    generatedAt: sheet.generatedAt,
  });

  return { buffer, filename: `balance-sheet-${sheet.asOf}.pdf` };
}

/** In prose the currency belongs on the figure; a zero reads better as a word. */
function formatNote(pesewas: number): string {
  return pesewas === 0 ? 'nil' : formatGhs(pesewas);
}

export async function profitAndLossPdf(pl: ProfitAndLoss): Promise<StatementFile> {
  const incomeLines: StatementLine[] = [
    { label: 'Susu commission', amount: pl.income.susuCommission, indent: 1 },
    { label: 'Savings fees', amount: pl.income.savingsFees, indent: 1 },
    { label: 'Loan interest', amount: pl.income.loanInterest, indent: 1 },
    { label: 'Hire purchase interest', amount: pl.income.hirePurchaseInterest, indent: 1 },
    { label: 'Outright sales margin', amount: pl.income.outrightSalesProfit, indent: 1 },
    { label: 'Total income', amount: pl.income.total, total: true },
  ];

  const expenseLines: StatementLine[] = [
    ...pl.expenses.byCategory.map((c): StatementLine => ({
      label: categoryLabel(c.category),
      amount: c.amount,
      indent: 1,
    })),
    { label: 'Depreciation', amount: pl.expenses.depreciation, indent: 1 },
    { label: 'Total expenses', amount: pl.expenses.total, total: true },
  ];

  // An empty expense section would print a bare total, which reads like an
  // error rather than a quiet month.
  if (pl.expenses.byCategory.length === 0) {
    expenseLines.unshift({ label: 'No expenses recorded in this period', indent: 1, muted: true });
  }

  const buffer = await buildStatementPdf({
    title: 'PROFIT AND LOSS',
    periodLabel: `For the period ${longDate(pl.from)} to ${longDate(pl.to)}`,
    sections: [
      { heading: 'Income', lines: incomeLines },
      { heading: 'Expenses', lines: expenseLines },
    ],
    highlight: {
      label: pl.netProfit < 0 ? 'Net loss for the period' : 'Net profit for the period',
      amount: pl.netProfit,
      caption:
        pl.netProfit < 0
          ? 'Expenses exceeded income over this period.'
          : 'Income less expenses, including depreciation.',
      alert: pl.netProfit < 0,
    },
    notes: [
      'Loan and hire purchase interest is recognised as it is repaid, not when the loan is ' +
        'written.',
      'Depreciation is computed straight-line from the fixed asset register.',
      'Expenses are counted against the period they were incurred in, which is not always ' +
        'the period they were paid in.',
      'All amounts are Ghana cedis.',
    ],
    generatedAt: pl.generatedAt,
  });

  return { buffer, filename: `profit-loss-${pl.from}-to-${pl.to}.pdf` };
}
