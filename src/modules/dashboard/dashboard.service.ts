import { accraDay, accraMonthKey } from '../../lib/time.js';
import { NOT_TRASHED } from '../../models/shared.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
} from '../../models/index.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { commissionEarned } from '../reports/reports.service.js';
import { transactionGroups } from '../reports/transactions.service.js';
import type { TxnType } from '../../domain/transactions.js';

/**
 * The admin dashboard summary. One REST endpoint, computed fresh on every call
 * — Socket.io money events tell the frontend WHEN to refetch, this endpoint is
 * WHAT the numbers are (sockets are never the source of truth).
 * All amounts are integer pesewas.
 *
 * `kpis` is a flattened read of the headline tiles: every value in it is
 * derived from `today` and `portfolio` below, and is repeated there only so
 * the frontend does not have to re-do the arithmetic per tile.
 */

interface CountAmount {
  count: number;
  amount: number;
}

/** The headline tiles, flattened. Every field is derived from the blocks below. */
export interface DashboardKpis {
  /** Customers with status 'active'. */
  totalCustomers: number;
  /** Open susu cycles + active savings + open loans + open HP agreements. */
  activeAccounts: number;
  /** Completed cycles whose payout has not been handed over yet. */
  pendingSusuPayouts: CountAmount;
  /** Today's cash in, pesewas. Internal transfers excluded. */
  amountCollectedToday: number;
  /**
   * Change against yesterday's cash in, as a percentage. Null when yesterday
   * took nothing — there is no percentage change from zero, and rendering one
   * as +100% or ∞ would be a lie.
   */
  amountCollectedChangePercent: number | null;
  /** Loans in arrears + HP agreements in arrears. */
  inArrears: number;
}

export interface DashboardMetrics {
  kpis: DashboardKpis;
  /** Cash movement for the current Accra day. Internal transfers excluded. */
  today: {
    day: string;
    cashIn: CountAmount;
    cashOut: CountAmount;
    internalMoves: CountAmount;
    in: {
      susuDeposits: CountAmount;
      savingsDeposits: CountAmount;
      loanRepayments: CountAmount;
      hpPayments: CountAmount;
    };
    out: {
      susuPayouts: CountAmount;
      savingsWithdrawals: CountAmount;
      loanDisbursements: CountAmount;
    };
  };
  /** Yesterday's cash in, for the day-on-day comparison on the collected tile. */
  yesterday: {
    day: string;
    cashIn: CountAmount;
  };
  /** Revenue for the current Accra month (1st → today). */
  monthToDate: {
    from: string;
    to: string;
    susuCommission: CountAmount;
    savingsFees: CountAmount;
    /** Margin on outright counter sales, voided ones excluded. */
    outrightSalesProfit: CountAmount;
    totalRevenue: number;
  };
  /** Live position — computed from account state, not from the feed. */
  portfolio: {
    customersActive: number;
    susu: {
      activeAccounts: number;
      completedAwaitingClosure: number;
      /** Sum of BALANCES on active + completed cycles — deposits less anything
       *  already taken by partial withdrawals. */
      valueHeld: number;
      pendingPayout: CountAmount;
    };
    savings: {
      activeAccounts: number;
      totalBalance: number;
      byType: { standard: CountAmount; student: CountAmount };
    };
    loans: {
      active: number;
      arrears: number;
      /** Sum of totalDue − totalRepaid over open loans. */
      outstanding: number;
    };
    hirePurchase: {
      active: number;
      inArrears: number;
      /** Sum of remaining balances (flat-interest remainingOn). */
      outstanding: number;
    };
  };
  generatedAt: Date;
}

const zero = (): CountAmount => ({ count: 0, amount: 0 });

/** Which `today` bucket each transaction type belongs to (internal rows excluded). */
const IN_BUCKET: Partial<Record<TxnType, keyof DashboardMetrics['today']['in']>> = {
  'susu-deposit': 'susuDeposits',
  'savings-deposit': 'savingsDeposits',
  'loan-repayment': 'loanRepayments',
  'hp-deposit': 'hpPayments',
  'hp-installment': 'hpPayments',
  'hp-redemption': 'hpPayments',
};
const OUT_BUCKET: Partial<Record<TxnType, keyof DashboardMetrics['today']['out']>> = {
  'susu-payout': 'susuPayouts',
  'savings-withdrawal': 'savingsWithdrawals',
  'savings-closure': 'savingsWithdrawals',
  'loan-disbursement': 'loanDisbursements',
};

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Day-on-day change as a percentage, rounded to one decimal. Null when the
 * previous day took nothing: a change from zero has no percentage.
 */
function changePercent(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

export async function dashboardMetrics(): Promise<DashboardMetrics> {
  const day = accraDay();
  const priorDay = accraDay(new Date(Date.now() - DAY_MS));
  const monthStart = `${accraMonthKey()}-01`;

  const [
    todayGroups,
    priorGroups,
    revenue,
    customersActive,
    susuGroups,
    savingsGroups,
    loanGroups,
    openHp,
  ] = await Promise.all([
    transactionGroups(day, day),
    transactionGroups(priorDay, priorDay),
    commissionEarned(monthStart, day),
    CustomerModel.countDocuments({ status: 'active', ...NOT_TRASHED }),
    SusuAccountModel.aggregate<{
      _id: string;
      count: number;
      balance: number;
      payoutRemaining: number;
    }>([
      { $match: { ...NOT_TRASHED } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 },
          // Money actually held, not the running deposit total: partial
          // withdrawals have already left the drawer.
          balance: {
            $sum: { $subtract: ['$totalDeposited', { $ifNull: ['$withdrawnAmount', 0] }] },
          },
          payoutRemaining: { $sum: '$payoutRemaining' },
        },
      },
    ]),
    SavingsAccountModel.aggregate<{ _id: string; count: number; balance: number }>([
      { $match: { status: 'active', ...NOT_TRASHED } },
      { $group: { _id: '$accountType', count: { $sum: 1 }, balance: { $sum: '$balance' } } },
    ]),
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
  ]);

  // ---- today's cash movement, bucketed by source
  const today: DashboardMetrics['today'] = {
    day,
    cashIn: { ...todayGroups.totals.in },
    cashOut: { ...todayGroups.totals.out },
    internalMoves: { ...todayGroups.totals.internal },
    in: {
      susuDeposits: zero(),
      savingsDeposits: zero(),
      loanRepayments: zero(),
      hpPayments: zero(),
    },
    out: { susuPayouts: zero(), savingsWithdrawals: zero(), loanDisbursements: zero() },
  };
  for (const g of todayGroups.groups) {
    if (g.direction === 'in') {
      const bucket = IN_BUCKET[g.type];
      if (bucket) {
        today.in[bucket].count += g.count;
        today.in[bucket].amount += g.amount;
      }
    } else if (g.direction === 'out') {
      const bucket = OUT_BUCKET[g.type];
      if (bucket) {
        today.out[bucket].count += g.count;
        today.out[bucket].amount += g.amount;
      }
    }
  }

  // ---- portfolio position
  const susuByStatus = new Map(susuGroups.map((g) => [g._id, g]));
  const active = susuByStatus.get('active');
  const completed = susuByStatus.get('completed');
  const pending = susuByStatus.get('pending-payout');

  const savingsByType = new Map(savingsGroups.map((g) => [g._id, g]));
  const standard = savingsByType.get('standard');
  const student = savingsByType.get('student');

  const loanByStatus = new Map(loanGroups.map((g) => [g._id, g]));

  const portfolio: DashboardMetrics['portfolio'] = {
    customersActive,
    susu: {
      activeAccounts: active?.count ?? 0,
      completedAwaitingClosure: completed?.count ?? 0,
      valueHeld: (active?.balance ?? 0) + (completed?.balance ?? 0),
      pendingPayout: {
        count: pending?.count ?? 0,
        amount: pending?.payoutRemaining ?? 0,
      },
    },
    savings: {
      activeAccounts: (standard?.count ?? 0) + (student?.count ?? 0),
      totalBalance: (standard?.balance ?? 0) + (student?.balance ?? 0),
      byType: {
        standard: { count: standard?.count ?? 0, amount: standard?.balance ?? 0 },
        student: { count: student?.count ?? 0, amount: student?.balance ?? 0 },
      },
    },
    loans: {
      active: loanByStatus.get('active')?.count ?? 0,
      arrears: loanByStatus.get('arrears')?.count ?? 0,
      outstanding:
        (loanByStatus.get('active')?.outstanding ?? 0) +
        (loanByStatus.get('arrears')?.outstanding ?? 0),
    },
    hirePurchase: {
      active: openHp.filter((a) => a.status === 'active').length,
      inArrears: openHp.filter((a) => a.status === 'in-arrears').length,
      outstanding: openHp.reduce((sum, a) => sum + remainingOn(a), 0),
    },
  };

  const yesterday = { day: priorDay, cashIn: { ...priorGroups.totals.in } };

  return {
    kpis: {
      totalCustomers: customersActive,
      // Every open account the customer can transact on, across all products.
      activeAccounts:
        portfolio.susu.activeAccounts +
        portfolio.savings.activeAccounts +
        portfolio.loans.active +
        portfolio.hirePurchase.active,
      pendingSusuPayouts: portfolio.susu.pendingPayout,
      amountCollectedToday: today.cashIn.amount,
      amountCollectedChangePercent: changePercent(today.cashIn.amount, yesterday.cashIn.amount),
      inArrears: portfolio.loans.arrears + portfolio.hirePurchase.inArrears,
    },
    today,
    yesterday,
    monthToDate: {
      from: revenue.from,
      to: revenue.to,
      susuCommission: revenue.susuCommission,
      savingsFees: revenue.savingsFees,
      outrightSalesProfit: revenue.outrightSalesProfit,
      totalRevenue: revenue.totalRevenue,
    },
    portfolio,
    generatedAt: new Date(),
  };
}
