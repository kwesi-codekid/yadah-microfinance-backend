import { accraDay, accraMonthKey } from '../../lib/time.js';
import {
  HpAgreementModel,
  HpItemModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { commissionEarned } from '../reports/reports.service.js';
import { cashPosition } from './cash.service.js';
import { accruedExpenses, expensesByCategory } from '../expenses/expenses.service.js';
import { assetPositionAt, capitalAt, depreciationExpense } from './fixed-assets.service.js';
import { interestEarned } from './income.service.js';

/**
 * The balance sheet: what the business owns, what it owes, and what is left.
 *
 * The identity that has to hold is `assets = liabilities + equity`. Two things
 * about this business make it worth stating plainly:
 *
 *   - **Customer deposits are LIABILITIES, not assets.** Susu and savings
 *     balances are money the business is holding on someone else's behalf and
 *     must give back. A microfinance that reads its deposit book as wealth is
 *     the classic way to go under.
 *
 *   - **Loans receivable is shown at principal outstanding.** Interest is
 *     recognised as it is repaid (client decision 2026-08-27), so interest not
 *     yet collected is disclosed separately as unearned rather than counted as
 *     an asset the business owns.
 *
 * Retained earnings are computed from the same components as the profit and
 * loss below, over all time up to the sheet date, so the two statements can
 * never disagree.
 *
 * All amounts are integer pesewas.
 */

/** Nothing in this system predates 2020; used as an open-ended "from". */
const EPOCH = '2020-01-01';

export interface BalanceSheet {
  asOf: string;
  assets: {
    current: {
      cashAndBank: number;
      /** Principal still owed on open loans. Excludes uncollected interest. */
      loansReceivable: number;
      hirePurchaseReceivable: number;
      /** Hire-purchase stock at COST, never at selling price. */
      inventory: number;
      total: number;
    };
    nonCurrent: {
      fixedAssetsAtCost: number;
      accumulatedDepreciation: number;
      netBookValue: number;
    };
    total: number;
  };
  liabilities: {
    /** Money held for customers, repayable on demand or at cycle end. */
    customerDeposits: {
      susuBalances: number;
      savingsBalances: number;
      susuPayoutsPending: number;
      total: number;
    };
    /** Expenses approved but not yet paid. */
    accruedExpenses: number;
    total: number;
  };
  equity: {
    contributedCapital: number;
    drawings: number;
    retainedEarnings: number;
    total: number;
  };
  /**
   * assets − (liabilities + equity). Should be zero.
   *
   * It is reported rather than hidden: a non-zero figure means the derived
   * cash position and the recorded books have drifted apart, and the client
   * needs to see that rather than read a sheet that was forced to balance.
   */
  checkDifference: number;
  balances: boolean;
  /** Figures the sheet deliberately does not treat as assets or income. */
  disclosures: {
    /** Interest on open loans not yet repaid, so not yet income. */
    unearnedLoanInterest: number;
    unearnedHpInterest: number;
    note: string;
  };
  generatedAt: Date;
}

async function customerLiabilities(): Promise<{
  susuBalances: number;
  savingsBalances: number;
  susuPayoutsPending: number;
}> {
  const [susu, savings] = await Promise.all([
    SusuAccountModel.aggregate<{ _id: string; balance: number; payoutRemaining: number }>([
      { $match: { ...NOT_TRASHED } },
      {
        $group: {
          _id: '$status',
          balance: {
            $sum: { $subtract: ['$totalDeposited', { $ifNull: ['$withdrawnAmount', 0] }] },
          },
          payoutRemaining: { $sum: '$payoutRemaining' },
        },
      },
    ]),
    SavingsAccountModel.aggregate<{ balance: number }>([
      { $match: { status: 'active', ...NOT_TRASHED } },
      { $group: { _id: null, balance: { $sum: '$balance' } } },
    ]),
  ]);

  const byStatus = new Map(susu.map((s) => [s._id, s]));
  return {
    // Money still held for open cycles. Closed and terminated accounts have
    // already been paid out and owe nothing.
    susuBalances:
      (byStatus.get('active')?.balance ?? 0) + (byStatus.get('completed')?.balance ?? 0),
    savingsBalances: savings[0]?.balance ?? 0,
    susuPayoutsPending: byStatus.get('pending-payout')?.payoutRemaining ?? 0,
  };
}

async function receivables(): Promise<{
  loanPrincipal: number;
  unearnedLoanInterest: number;
  hpReceivable: number;
  unearnedHpInterest: number;
}> {
  const [loans, agreements] = await Promise.all([
    LoanModel.find({ status: { $in: ['active', 'arrears'] }, ...NOT_TRASHED }),
    HpAgreementModel.find({ status: { $in: ['active', 'in-arrears'] }, ...NOT_TRASHED }),
  ]);

  let loanPrincipal = 0;
  let unearnedLoanInterest = 0;
  for (const loan of loans) {
    const outstanding = loan.totalDue - loan.totalRepaid;
    // Repayments are applied to the loan as a whole, so the outstanding amount
    // is split in the same proportion as the original principal to interest.
    const interestShare =
      loan.totalDue === 0 ? 0 : Math.round((outstanding * loan.interestAmount) / loan.totalDue);
    unearnedLoanInterest += interestShare;
    loanPrincipal += outstanding - interestShare;
  }

  let hpReceivable = 0;
  let unearnedHpInterest = 0;
  for (const agreement of agreements) {
    const outstanding = remainingOn(agreement);
    const totalPayable = agreement.totalPayable ?? 0;
    const interest = agreement.interestAmount ?? 0;
    const interestShare =
      totalPayable === 0 ? 0 : Math.round((outstanding * interest) / totalPayable);
    unearnedHpInterest += interestShare;
    hpReceivable += outstanding - interestShare;
  }

  return { loanPrincipal, unearnedLoanInterest, hpReceivable, unearnedHpInterest };
}

/** Hire-purchase stock on hand, valued at cost — never at what it will sell for. */
async function inventoryAtCost(): Promise<number> {
  const [row] = await HpItemModel.aggregate<{ value: number }>([
    { $match: { status: 'active', ...NOT_TRASHED } },
    { $group: { _id: null, value: { $sum: { $multiply: ['$quantityInStock', '$costPrice'] } } } },
  ]);
  return row?.value ?? 0;
}

export async function balanceSheet(asOf: string = accraDay()): Promise<BalanceSheet> {
  const [cash, deposits, recv, inventory, fixedAssets, capital, accrued, earnings] =
    await Promise.all([
      cashPosition(asOf),
      customerLiabilities(),
      receivables(),
      inventoryAtCost(),
      assetPositionAt(asOf),
      capitalAt(asOf),
      accruedExpenses(asOf),
      retainedEarnings(asOf),
    ]);

  const currentAssets = cash.total + recv.loanPrincipal + recv.hpReceivable + inventory;
  const totalAssets = currentAssets + fixedAssets.netBookValue;

  const depositsTotal =
    deposits.susuBalances + deposits.savingsBalances + deposits.susuPayoutsPending;
  const totalLiabilities = depositsTotal + accrued.amount;

  const totalEquity = capital.net + earnings;
  const checkDifference = totalAssets - (totalLiabilities + totalEquity);

  return {
    asOf,
    assets: {
      current: {
        cashAndBank: cash.total,
        loansReceivable: recv.loanPrincipal,
        hirePurchaseReceivable: recv.hpReceivable,
        inventory,
        total: currentAssets,
      },
      nonCurrent: {
        fixedAssetsAtCost: fixedAssets.cost,
        accumulatedDepreciation: fixedAssets.accumulatedDepreciation,
        netBookValue: fixedAssets.netBookValue,
      },
      total: totalAssets,
    },
    liabilities: {
      customerDeposits: {
        susuBalances: deposits.susuBalances,
        savingsBalances: deposits.savingsBalances,
        susuPayoutsPending: deposits.susuPayoutsPending,
        total: depositsTotal,
      },
      accruedExpenses: accrued.amount,
      total: totalLiabilities,
    },
    equity: {
      contributedCapital: capital.contributions,
      drawings: capital.drawings,
      retainedEarnings: earnings,
      total: totalEquity,
    },
    checkDifference,
    balances: checkDifference === 0,
    disclosures: {
      unearnedLoanInterest: recv.unearnedLoanInterest,
      unearnedHpInterest: recv.unearnedHpInterest,
      note:
        'Interest is recognised as it is repaid, so interest not yet collected on open ' +
        'loans and agreements is disclosed here rather than counted as an asset.',
    },
    generatedAt: new Date(),
  };
}

// ---------------------------------------------------------------- profit and loss

export interface ProfitAndLoss {
  from: string;
  to: string;
  income: {
    susuCommission: number;
    savingsFees: number;
    outrightSalesProfit: number;
    loanInterest: number;
    hirePurchaseInterest: number;
    total: number;
  };
  expenses: {
    byCategory: { category: string; count: number; amount: number }[];
    recorded: number;
    /** Computed straight-line from the asset register, not a recorded expense. */
    depreciation: number;
    total: number;
  };
  netProfit: number;
  generatedAt: Date;
}

export async function profitAndLoss(from?: string, to?: string): Promise<ProfitAndLoss> {
  const end = to ?? accraDay();
  const start = from ?? `${accraMonthKey()}-01`;

  const [revenue, interest, byCategory, depreciation] = await Promise.all([
    commissionEarned(start, end),
    interestEarned(start, end),
    expensesByCategory(start, end),
    depreciationExpense(start, end),
  ]);

  const income = {
    susuCommission: revenue.susuCommission.amount,
    savingsFees: revenue.savingsFees.amount,
    outrightSalesProfit: revenue.outrightSalesProfit.amount,
    loanInterest: interest.loanInterest,
    hirePurchaseInterest: interest.hpInterest,
    total: revenue.totalRevenue + interest.total,
  };

  const recorded = byCategory.reduce((sum, c) => sum + c.amount, 0);
  const totalExpenses = recorded + depreciation;

  return {
    from: start,
    to: end,
    income,
    expenses: { byCategory, recorded, depreciation, total: totalExpenses },
    netProfit: income.total - totalExpenses,
    generatedAt: new Date(),
  };
}

/**
 * Accumulated profit from the beginning up to a date.
 *
 * Built from the same pieces as profitAndLoss over an open-ended period, so
 * the balance sheet's equity and the profit and loss statement can never
 * disagree about what the business has earned.
 */
async function retainedEarnings(asOf: string): Promise<number> {
  const pl = await profitAndLoss(EPOCH, asOf);
  return pl.netProfit;
}
