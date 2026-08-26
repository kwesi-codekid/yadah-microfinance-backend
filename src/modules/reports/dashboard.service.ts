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
import { commissionEarned } from './reports.service.js';
import { transactionGroups } from './transactions.service.js';
import type { TxnType } from '../../domain/transactions.js';

/**
 * The admin dashboard payload (WBS 6.1). One REST endpoint, computed fresh on
 * every call — Socket.io money events tell the frontend WHEN to refetch, this
 * endpoint is WHAT the numbers are (sockets are never the source of truth).
 * All amounts are integer pesewas.
 */

interface CountAmount {
  count: number;
  amount: number;
}

export interface DashboardMetrics {
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

export async function dashboardMetrics(): Promise<DashboardMetrics> {
  const day = accraDay();
  const monthStart = `${accraMonthKey()}-01`;

  const [todayGroups, revenue, customersActive, susuGroups, savingsGroups, loanGroups, openHp] =
    await Promise.all([
      transactionGroups(day, day),
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

  return {
    today,
    monthToDate: {
      from: revenue.from,
      to: revenue.to,
      susuCommission: revenue.susuCommission,
      savingsFees: revenue.savingsFees,
      outrightSalesProfit: revenue.outrightSalesProfit,
      totalRevenue: revenue.totalRevenue,
    },
    portfolio: {
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
    },
    generatedAt: new Date(),
  };
}
