import { accraDay } from '../../lib/time.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { HpAgreementModel, LoanModel } from '../../models/index.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { commissionEarned } from '../reports/reports.service.js';
import { transactionGroups } from '../reports/transactions.service.js';
import {
  collateralHeldAt,
  customerLiabilities,
  profitAndLoss,
  type ProfitAndLoss,
} from '../accounting/balance-sheet.service.js';
import { cashPosition } from '../accounting/cash.service.js';
import { bucketKeyOfDay, type Bucket } from './series.service.js';
import type { SeriesQuery } from './dashboard.schemas.js';

/**
 * The money-first block of the office dashboard: what the business holds,
 * what it owes customers, what is out on loan, and what it has earned.
 *
 * Office-only (admin and manager). The counter reads /dashboard/summary for
 * the cash it handles; profit and the cash accounts are not theirs to see.
 *
 * Every figure is built from the same services as the balance sheet and the
 * profit and loss statement, so the dashboard can never disagree with the
 * statements the office prints. All amounts are integer pesewas.
 */

/** Nothing in this system predates 2020; the open-ended "from" for all time. */
const EPOCH = '2020-01-01';

interface CountAmount {
  count: number;
  amount: number;
}

export interface DashboardFinancials {
  asOf: string;
  cash: {
    /** Every active cash account plus the commission account. */
    total: number;
    commission: number;
    accounts: { id: string; name: string; kind: string; balance: number }[];
  };
  /** Customer money held — a liability, repayable on demand. */
  deposits: {
    susu: number;
    savings: number;
    susuLoan: number;
    collateral: number;
    total: number;
  };
  /** Cash on hand as a share of deposits, one decimal. Null when nothing is held. */
  liquidityPercent: number | null;
  loanBook: {
    /** Loans plus hire purchase still owed to the business. */
    outstanding: number;
    loans: { open: number; outstanding: number; arrearsCount: number; arrearsAmount: number };
    hirePurchase: {
      open: number;
      outstanding: number;
      arrearsCount: number;
      arrearsAmount: number;
    };
    /** Portfolio at risk: share of the outstanding book in arrears, one decimal. */
    parPercent: number | null;
    disbursedThisMonth: CountAmount;
    repaidThisMonth: CountAmount;
  };
  /**
   * Everything that lands in the commission account — susu commission,
   * savings fees and loan processing fees — since the system began.
   */
  commissionAllTime: number;
  profit: {
    thisMonth: ProfitSummary;
    /** The same span of days last month, so a part month compares fairly. */
    lastMonth: ProfitSummary;
  };
  trend: {
    from: string;
    to: string;
    bucket: Bucket;
    points: { key: string; revenue: number; expenses: number; netProfit: number }[];
  };
  generatedAt: Date;
}

export interface ProfitSummary {
  from: string;
  to: string;
  income: ProfitAndLoss['income'];
  expenses: number;
  netProfit: number;
}

/** `part` as a percentage of `whole`, one decimal. Null when `whole` is not positive. */
export function percentOf(part: number, whole: number): number | null {
  if (whole <= 0) return null;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * The first day of last month through the same day-of-month as `day`, clamped
 * to last month's length — 31 March compares with the whole of February.
 */
export function sameSpanLastMonth(day: string): { from: string; to: string } {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7)); // 1-12
  const prevYear = month === 1 ? year - 1 : year;
  const prevMonth = month === 1 ? 12 : month - 1;
  const lastDay = new Date(Date.UTC(prevYear, prevMonth, 0)).getUTCDate();
  const dom = Math.min(Number(day.slice(8, 10)), lastDay);
  const ym = `${String(prevYear)}-${String(prevMonth).padStart(2, '0')}`;
  return { from: `${ym}-01`, to: `${ym}-${String(dom).padStart(2, '0')}` };
}

/**
 * Each bucket in the range as an inclusive day span, clamped to `from`/`to` so
 * a partial first or last week or month covers only the days asked for.
 */
export function bucketRanges(
  from: string,
  to: string,
  bucket: Bucket,
): { key: string; from: string; to: string }[] {
  const ranges: { key: string; from: string; to: string }[] = [];
  const end = new Date(`${to}T00:00:00.000Z`).getTime();
  for (let t = new Date(`${from}T00:00:00.000Z`).getTime(); t <= end; t += 86_400_000) {
    const day = accraDay(new Date(t));
    const key = bucketKeyOfDay(day, bucket);
    const last = ranges[ranges.length - 1];
    if (last?.key === key) last.to = day;
    else ranges.push({ key, from: day, to: day });
  }
  return ranges;
}

function summarise(pl: ProfitAndLoss): ProfitSummary {
  return {
    from: pl.from,
    to: pl.to,
    income: pl.income,
    expenses: pl.expenses.total,
    netProfit: pl.netProfit,
  };
}

export async function dashboardFinancials(range: SeriesQuery): Promise<DashboardFinancials> {
  const day = accraDay();
  const monthStart = `${day.slice(0, 7)}-01`;
  const last = sameSpanLastMonth(day);
  const buckets = bucketRanges(range.from, range.to, range.bucket);

  const [
    cash,
    liabilities,
    collateral,
    loanGroups,
    openHp,
    monthGroups,
    thisMonth,
    lastMonth,
    trend,
    earned,
  ] = await Promise.all([
    cashPosition(day),
    customerLiabilities(),
    collateralHeldAt(day),
    LoanModel.aggregate<{ _id: string; count: number; outstanding: number }>([
      { $match: { status: { $in: ['active', 'arrears'] }, ...NOT_TRASHED } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          outstanding: { $sum: { $subtract: ['$totalDue', '$totalRepaid'] } },
        },
      },
    ]),
    HpAgreementModel.find({ status: { $in: ['active', 'in-arrears'] }, ...NOT_TRASHED }),
    transactionGroups(monthStart, day),
    profitAndLoss(monthStart, day),
    profitAndLoss(last.from, last.to),
    Promise.all(buckets.map((b) => profitAndLoss(b.from, b.to))),
    commissionEarned(EPOCH, day),
  ]);

  const deposits = {
    susu: liabilities.susuBalances,
    savings: liabilities.savingsBalances,
    susuLoan: liabilities.susuLoanBalances,
    collateral,
    total:
      liabilities.susuBalances +
      liabilities.savingsBalances +
      liabilities.susuLoanBalances +
      collateral,
  };

  const loanByStatus = new Map(loanGroups.map((g) => [g._id, g]));
  const activeLoans = loanByStatus.get('active');
  const arrearsLoans = loanByStatus.get('arrears');
  const loans = {
    open: (activeLoans?.count ?? 0) + (arrearsLoans?.count ?? 0),
    outstanding: (activeLoans?.outstanding ?? 0) + (arrearsLoans?.outstanding ?? 0),
    arrearsCount: arrearsLoans?.count ?? 0,
    arrearsAmount: arrearsLoans?.outstanding ?? 0,
  };

  const hpInArrears = openHp.filter((a) => a.status === 'in-arrears');
  const hirePurchase = {
    open: openHp.length,
    outstanding: openHp.reduce((sum, a) => sum + remainingOn(a), 0),
    arrearsCount: hpInArrears.length,
    arrearsAmount: hpInArrears.reduce((sum, a) => sum + remainingOn(a), 0),
  };

  const disbursedThisMonth: CountAmount = { count: 0, amount: 0 };
  const repaidThisMonth: CountAmount = { count: 0, amount: 0 };
  for (const g of monthGroups.groups) {
    const into =
      g.type === 'loan-disbursement'
        ? disbursedThisMonth
        : g.type === 'loan-repayment'
          ? repaidThisMonth
          : null;
    if (into) {
      into.count += g.count;
      into.amount += g.amount;
    }
  }

  const outstanding = loans.outstanding + hirePurchase.outstanding;

  return {
    asOf: day,
    cash: {
      total: cash.total,
      commission: cash.commission,
      accounts: cash.accounts.map((a) => ({
        id: a.id,
        name: a.name,
        kind: a.kind,
        balance: a.balance,
      })),
    },
    deposits,
    liquidityPercent: percentOf(cash.total, deposits.total),
    loanBook: {
      outstanding,
      loans,
      hirePurchase,
      parPercent: percentOf(loans.arrearsAmount + hirePurchase.arrearsAmount, outstanding),
      disbursedThisMonth,
      repaidThisMonth,
    },
    commissionAllTime:
      earned.susuCommission.amount + earned.savingsFees.amount + earned.loanProcessingFees.amount,
    profit: { thisMonth: summarise(thisMonth), lastMonth: summarise(lastMonth) },
    trend: {
      from: range.from,
      to: range.to,
      bucket: range.bucket,
      points: trend.map((pl, i) => ({
        key: buckets[i]?.key ?? pl.from,
        revenue: pl.income.total,
        expenses: pl.expenses.total,
        netProfit: pl.netProfit,
      })),
    },
    generatedAt: new Date(),
  };
}
