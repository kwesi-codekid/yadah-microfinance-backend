import type { PipelineStage, Types } from 'mongoose';
import { directionOf, type TxnType } from '../../domain/transactions.js';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  HpAgreementModel,
  HpItemModel,
  HpLabelModel,
  HpSaleModel,
  LoanModel,
  ReconciliationModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuCycleModel,
  SusuDepositModel,
  SusuPlanModel,
  UserModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { interestEarned } from '../accounting/income.service.js';
import { remainingOn } from '../hire-purchase/hp.service.js';
import { commissionEarned } from './reports.service.js';
import { buildFeedUnion } from './transactions.service.js';

/**
 * The office's reading of the whole business over a period — the data behind
 * the Reports page, one block per tab.
 *
 * Every figure is read from the books through the same doors the other
 * screens use: cash moved comes off the unified transaction feed (so it is
 * the ledger's cash in and out, transfers left out), revenue from the
 * commission account and the interest the profit and loss recognises, and
 * balances from the accounts themselves. Nothing here is estimated except
 * where a comment says so. All amounts are integer pesewas.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_LABELS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export const OVERVIEW_PERIODS = { month: 1, quarter: 3, year: 12 } as const;
export type OverviewPeriod = keyof typeof OVERVIEW_PERIODS;

interface MonthPoint {
  /** `YYYY-MM`. */
  key: string;
  label: string;
  /** True for the month still running. */
  partial: boolean;
}
interface BookMonth extends MonthPoint {
  inflow: number;
  outflow: number;
}

export interface ReportsOverview {
  period: OverviewPeriod;
  from: string;
  to: string;
  generatedAt: string;
  kpis: {
    depositsMobilised: number;
    depositsDelta: number;
    withdrawalsPaid: number;
    loansDisbursed: number;
    loansCount: number;
    par30: number;
    par30Delta: number;
    revenue: number;
    revenueDelta: number;
    handoverVariance: number;
    handoverDays: number;
  };
  flow: (MonthPoint & {
    susu: number;
    savings: number;
    loans: number;
    hp: number;
    sales: number;
  })[];
  susu: {
    accounts: number;
    valueHeld: number;
    collectedPerDay: number[];
    cycles: { label: string; count: number }[];
    payoutsDue: { count: number; amount: number };
    months: BookMonth[];
  };
  savings: { accounts: number; balance: number; months: BookMonth[]; balances: number[] };
  loans: {
    open: number;
    outstanding: number;
    months: BookMonth[];
    parTrend: number[];
    aging: { key: string; label: string; count: number; amount: number }[];
    overdue: {
      id: string;
      customer: string;
      principal: number;
      remaining: number;
      daysOverdue: number;
      collector: string;
    }[];
  };
  hp: {
    contracts: number;
    outstanding: number;
    statuses: { label: string; count: number; amount: number }[];
  };
  sales: {
    receipts: number;
    total: number;
    voided: number;
    categories: { category: string; outright: number; hp: number; units: number }[];
  };
  staff: {
    id: string;
    name: string;
    role: 'collector' | 'teller';
    recorded: number;
    confirmed: number;
    customers: number;
    daysReconciled: number;
    daysWorked: number;
  }[];
  handover: {
    days: string[];
    rows: { staffId: string; name: string; cells: { day: string; variance: number | null }[] }[];
  };
  customers: {
    total: number;
    months: (MonthPoint & { joined: number; dormant: number; active: number })[];
    byProduct: { label: string; count: number }[];
  };
  revenue: (MonthPoint & {
    susuCommission: number;
    /** Savings withdrawal fees and loan processing fees. */
    savingsFees: number;
    /** Loan interest and hire purchase interest, as repaid. */
    loanInterest: number;
    salesMargin: number;
  })[];
}

/** The months the page draws: at least three, ending with the running one. */
function monthsEnding(to: string, count: number): MonthPoint[] {
  const year = Number(to.slice(0, 4));
  const month = Number(to.slice(5, 7)) - 1;
  const out: MonthPoint[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(year, month - i, 1));
    out.push({
      key: d.toISOString().slice(0, 7),
      label: MONTH_LABELS[d.getUTCMonth()] ?? '',
      partial: i === 0,
    });
  }
  return out;
}

/** The first instant after a `YYYY-MM` month. */
function monthEnd(key: string): Date {
  return new Date(Date.UTC(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 1));
}
/** The last Accra day of a month, or `to` for the running one. */
function lastDayOf(key: string, to: string): string {
  const last = accraDay(new Date(monthEnd(key).getTime() - DAY_MS));
  return last > to ? to : last;
}

const fraction = (part: number, whole: number): number => (whole > 0 ? part / whole : 0);
const change = (now: number, before: number): number => (before > 0 ? (now - before) / before : 0);
const sum = <T>(rows: readonly T[], pick: (row: T) => number): number =>
  rows.reduce((n, row) => n + pick(row), 0);

interface FeedGroup {
  _id: {
    month: string;
    day: string;
    type: TxnType;
    channel: string | null;
    detail: string | null;
    staff: Types.ObjectId | null;
    byRole: string | null;
  };
  amount: number;
  count: number;
}

const SYSTEM_ACTOR_HEX = '000000000000000000000000';

export async function reportsOverview(period: OverviewPeriod): Promise<ReportsOverview> {
  const to = accraDay();
  const months = monthsEnding(to, Math.max(OVERVIEW_PERIODS[period], 3));
  const first = months[0];
  if (!first) throw new Error('no months to report on');
  const from = `${first.key}-01`;
  const start = new Date(`${from}T00:00:00.000Z`);
  const end = new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS);
  const createdAt = { $gte: start, $lt: end };
  const now = Date.now();

  const groupStage: PipelineStage.Group = {
    $group: {
      _id: {
        month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
        day: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        type: '$type',
        channel: '$channel',
        detail: '$detail',
        staff: '$recordedById',
        byRole: { $ifNull: ['$initiatedByRole', null] },
      },
      amount: { $sum: '$amount' },
      count: { $sum: 1 },
    },
  };

  const [
    feed,
    susuOpen,
    plans,
    cyclesEnded,
    savingsOpen,
    savingsMoves,
    openLoans,
    loansEver,
    repaymentsEver,
    openHp,
    hpSettled,
    hpSigned,
    sales,
    voided,
    recons,
    customersActive,
    joined,
    deactivated,
    customersBefore,
    revenueByMonth,
  ] = await Promise.all([
    SusuDepositModel.aggregate<FeedGroup>([...buildFeedUnion({ start, end }), groupStage]),
    SusuAccountModel.aggregate<{ count: number; balance: number; ids: Types.ObjectId[] }>([
      { $match: { status: 'active', ...NOT_TRASHED } },
      {
        $group: {
          _id: null,
          count: { $sum: 1 },
          balance: { $sum: '$balance' },
          ids: { $push: '$_id' },
        },
      },
    ]),
    SusuPlanModel.find({ status: 'active' }, { accountId: 1, paidInCycle: 1 }),
    SusuCycleModel.aggregate<{ count: number; commission: number }>([
      { $match: { endedAt: createdAt, endReason: 'completed' } },
      { $group: { _id: null, count: { $sum: 1 }, commission: { $sum: '$commissionAmount' } } },
    ]),
    SavingsAccountModel.aggregate<{ count: number; balance: number }>([
      { $match: { status: 'active', ...NOT_TRASHED } },
      { $group: { _id: null, count: { $sum: 1 }, balance: { $sum: '$balance' } } },
    ]),
    // Every movement on a savings balance, transfers included: what a month
    // end held is today's balance with the later movements taken back off.
    SavingsTxnModel.aggregate<{
      _id: { month: string; type: string };
      amount: number;
      fee: number;
    }>([
      { $match: { createdAt: { $gte: start }, ...NOT_TRASHED } },
      {
        $group: {
          _id: { month: { $dateToString: { format: '%Y-%m', date: '$createdAt' } }, type: '$type' },
          amount: { $sum: '$amount' },
          fee: { $sum: { $ifNull: ['$fee', 0] } },
        },
      },
    ]),
    LoanModel.find({ status: { $in: ['active', 'arrears'] }, ...NOT_TRASHED }),
    // For the month-end trend: every loan that has gone out, and what had
    // been repaid on each by any given day.
    LoanModel.find(
      {
        disbursedAt: { $exists: true },
        status: { $in: ['active', 'arrears', 'repaid'] },
        ...NOT_TRASHED,
      },
      { totalDue: 1, disbursedAt: 1, dueDate: 1, closedAt: 1, status: 1 },
    ),
    RepaymentModel.find({ ...NOT_TRASHED }, { loanId: 1, amount: 1, createdAt: 1 }),
    HpAgreementModel.find({
      status: { $in: ['active', 'in-arrears', 'repossessed'] },
      ...NOT_TRASHED,
    }),
    HpAgreementModel.countDocuments({
      status: { $in: ['closed-completed', 'closed-redeemed'] },
      closedAt: createdAt,
      ...NOT_TRASHED,
    }),
    HpAgreementModel.find(
      { createdAt, status: { $nin: ['rejected', 'awaiting-approval'] }, ...NOT_TRASHED },
      { itemId: 1, agreedPrice: 1 },
    ),
    HpSaleModel.find({ createdAt, status: 'completed' }, { lines: 1, total: 1 }),
    HpSaleModel.countDocuments({ createdAt, status: 'voided' }),
    ReconciliationModel.find({ accraDay: { $gte: from, $lte: to } }),
    CustomerModel.countDocuments({ status: 'active', ...NOT_TRASHED }),
    CustomerModel.aggregate<{ _id: string; count: number }>([
      { $match: { createdAt, ...NOT_TRASHED } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
          count: { $sum: 1 },
        },
      },
    ]),
    // The books keep no "went dormant" date. A customer switched off is the
    // nearest thing they record, read by when the record last changed.
    CustomerModel.aggregate<{ _id: string; count: number }>([
      { $match: { status: 'inactive', updatedAt: createdAt, ...NOT_TRASHED } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m', date: '$updatedAt' } },
          count: { $sum: 1 },
        },
      },
    ]),
    CustomerModel.countDocuments({ createdAt: { $lt: start }, ...NOT_TRASHED }),
    Promise.all(
      months.map(async (m) => {
        const [earned, interest] = await Promise.all([
          commissionEarned(`${m.key}-01`, lastDayOf(m.key, to)),
          interestEarned(`${m.key}-01`, lastDayOf(m.key, to)),
        ]);
        return { earned, interest };
      }),
    ),
  ]);

  // ---------------------------------------------------------------- cash moved
  const cashOf = (
    month: string | null,
    types: readonly TxnType[],
    direction: 'in' | 'out',
  ): number =>
    sum(
      feed.filter(
        (g) =>
          (month === null || g._id.month === month) &&
          types.includes(g._id.type) &&
          directionOf(g._id.type, g._id.channel, g._id.detail) === direction,
      ),
      (g) => g.amount,
    );
  const countOf = (types: readonly TxnType[], direction: 'in' | 'out'): number =>
    sum(
      feed.filter(
        (g) =>
          types.includes(g._id.type) &&
          directionOf(g._id.type, g._id.channel, g._id.detail) === direction,
      ),
      (g) => g.count,
    );

  const SUSU_IN: TxnType[] = ['susu-deposit'];
  const SUSU_OUT: TxnType[] = ['susu-payout', 'susu-withdrawal'];
  const SAVINGS_IN: TxnType[] = ['savings-deposit'];
  const SAVINGS_OUT: TxnType[] = ['savings-withdrawal', 'savings-closure'];
  const LOANS_IN: TxnType[] = ['loan-repayment'];
  const LOANS_OUT: TxnType[] = ['loan-disbursement'];
  const HP_IN: TxnType[] = ['hp-deposit', 'hp-installment', 'hp-redemption'];
  const SALES_IN: TxnType[] = ['hp-sale'];

  const book = (ins: TxnType[], outs: TxnType[]): BookMonth[] =>
    months.map((m) => ({
      ...m,
      inflow: cashOf(m.key, ins, 'in'),
      outflow: cashOf(m.key, outs, 'out'),
    }));
  const susuMonths = book(SUSU_IN, SUSU_OUT);
  const savingsMonths = book(SAVINGS_IN, SAVINGS_OUT);
  const loanMonths = book(LOANS_IN, LOANS_OUT);
  const flow = months.map((m) => ({
    ...m,
    susu: cashOf(m.key, SUSU_IN, 'in'),
    savings: cashOf(m.key, SAVINGS_IN, 'in'),
    loans: cashOf(m.key, LOANS_IN, 'in'),
    hp: cashOf(m.key, HP_IN, 'in'),
    sales: cashOf(m.key, SALES_IN, 'in'),
  }));

  // ---------------------------------------------------------------- susu
  // A typical week: what was collected on each weekday, averaged over how
  // many of that weekday the period holds. Monday first; Sunday is left out.
  const weekdayTotals = [0, 0, 0, 0, 0, 0, 0];
  const weekdayCounts = [0, 0, 0, 0, 0, 0, 0];
  for (let t = start.getTime(); t < end.getTime(); t += DAY_MS) {
    const d = new Date(t).getUTCDay();
    weekdayCounts[d] = (weekdayCounts[d] ?? 0) + 1;
  }
  for (const g of feed) {
    if (g._id.type !== 'susu-deposit') continue;
    if (directionOf(g._id.type, g._id.channel, g._id.detail) !== 'in') continue;
    const d = new Date(`${g._id.day}T12:00:00.000Z`).getUTCDay();
    weekdayTotals[d] = (weekdayTotals[d] ?? 0) + g.amount;
  }
  const collectedPerDay = [1, 2, 3, 4, 5, 6].map((d) =>
    Math.round(fraction(weekdayTotals[d] ?? 0, weekdayCounts[d] ?? 0)),
  );

  const openSusuIds = new Set((susuOpen[0]?.ids ?? []).map((id) => id.toHexString()));
  const running = plans.filter((p) => openSusuIds.has(p.accountId.toHexString()));
  const stage = (lo: number, hi: number): number =>
    running.filter((p) => p.paidInCycle >= lo && p.paidInCycle <= hi).length;
  const completed = cyclesEnded[0]?.count ?? 0;

  // ---------------------------------------------------------------- savings
  // Month-end balances, walked back from what the accounts hold today.
  const netOf = (month: string): number =>
    sum(
      savingsMoves.filter((m) => m._id.month === month),
      (m) => (m._id.type === 'deposit' ? m.amount : -(m.amount + m.fee)),
    );
  const savingsBalance = savingsOpen[0]?.balance ?? 0;
  const balances: number[] = [];
  let closing = savingsBalance;
  for (let i = months.length - 1; i >= 0; i--) {
    balances[i] = closing;
    closing -= netOf(months[i]?.key ?? '');
  }

  // ---------------------------------------------------------------- loans
  const outstanding = sum(openLoans, (l) => l.totalDue - l.totalRepaid);
  const lateDays = (dueDate: Date | undefined, at: number): number =>
    dueDate ? Math.max(0, Math.floor((at - dueDate.getTime()) / DAY_MS)) : 0;
  const late = openLoans
    .map((l) => ({ loan: l, days: lateDays(l.dueDate, now) }))
    .filter((r) => r.days > 0);
  const bucket = (key: string, label: string, lo: number, hi: number) => {
    const rows = late.filter((r) => r.days >= lo && r.days <= hi);
    return {
      key,
      label,
      count: rows.length,
      amount: sum(rows, (r) => r.loan.totalDue - r.loan.totalRepaid),
    };
  };
  const aging = [
    bucket('1-30', '1–30 days', 1, 30),
    bucket('31-60', '31–60 days', 31, 60),
    bucket('61-90', '61–90 days', 61, 90),
    bucket('90+', '90+ days', 91, Number.MAX_SAFE_INTEGER),
  ];
  const par30 = fraction(
    sum(aging.slice(1), (b) => b.amount),
    outstanding,
  );

  // Portfolio at risk at each month end: what was still owed on loans more
  // than thirty days past their due date, over everything owed that day. Read
  // at today's total due — a rate raised since is not unwound.
  const repaidBy = (loanId: string, at: number): number =>
    sum(
      repaymentsEver.filter((r) => r.loanId.toHexString() === loanId && r.createdAt.getTime() < at),
      (r) => r.amount,
    );
  const parTrend = months.map((m, i) => {
    if (i === months.length - 1) return par30;
    const at = monthEnd(m.key).getTime();
    let owed = 0;
    let atRisk = 0;
    for (const l of loansEver) {
      if (!l.disbursedAt || l.disbursedAt.getTime() >= at) continue;
      if (l.status === 'repaid' && l.closedAt && l.closedAt.getTime() < at) continue;
      const remaining = Math.max(0, l.totalDue - repaidBy(l._id.toHexString(), at));
      owed += remaining;
      if (lateDays(l.dueDate, at) > 30) atRisk += remaining;
    }
    return fraction(atRisk, owed);
  });

  const worst = [...late].sort((a, b) => b.days - a.days).slice(0, 6);
  const worstCustomers = await CustomerModel.find(
    { _id: { $in: worst.map((r) => r.loan.customerId) } },
    { fullName: 1, assignedCollectorId: 1 },
  );
  const customerById = new Map(worstCustomers.map((c) => [c._id.toHexString(), c]));

  // ---------------------------------------------------------------- hire purchase
  const standing = (label: string, status: string) => {
    const rows = openHp.filter((a) => a.status === status);
    return { label, count: rows.length, amount: sum(rows, (a) => remainingOn(a)) };
  };

  // ---------------------------------------------------------------- sales
  const itemIds = [
    ...new Set([
      ...sales.flatMap((s) => s.lines.map((l) => l.itemId.toHexString())),
      ...hpSigned.map((a) => a.itemId.toHexString()),
    ]),
  ];
  const items = await HpItemModel.find({ _id: { $in: itemIds } }, { categoryId: 1 });
  const labels = await HpLabelModel.find(
    { _id: { $in: items.flatMap((i) => (i.categoryId ? [i.categoryId] : [])) } },
    { name: 1 },
  );
  const labelName = new Map(labels.map((l) => [l._id.toHexString(), l.name]));
  const categoryOf = new Map(
    items.map((i) => [
      i._id.toHexString(),
      (i.categoryId && labelName.get(i.categoryId.toHexString())) ?? 'Uncategorised',
    ]),
  );
  const byCategory = new Map<
    string,
    { category: string; outright: number; hp: number; units: number }
  >();
  const category = (itemId: Types.ObjectId) => {
    const name = categoryOf.get(itemId.toHexString()) ?? 'Uncategorised';
    let row = byCategory.get(name);
    if (!row) {
      row = { category: name, outright: 0, hp: 0, units: 0 };
      byCategory.set(name, row);
    }
    return row;
  };
  for (const sale of sales) {
    for (const line of sale.lines) {
      const row = category(line.itemId);
      row.outright += line.lineTotal;
      row.units += line.quantity;
    }
  }
  for (const agreement of hpSigned) {
    const row = category(agreement.itemId);
    row.hp += agreement.agreedPrice ?? 0;
    row.units += 1;
  }

  // ---------------------------------------------------------------- staff and handover
  const taken = new Map<string, { recorded: number; days: Set<string> }>();
  for (const g of feed) {
    const id = g._id.staff?.toHexString() ?? null;
    if (id === null || id === SYSTEM_ACTOR_HEX || g._id.byRole === 'customer') continue;
    if (directionOf(g._id.type, g._id.channel, g._id.detail) !== 'in') continue;
    let row = taken.get(id);
    if (!row) {
      row = { recorded: 0, days: new Set() };
      taken.set(id, row);
    }
    row.recorded += g.amount;
    row.days.add(g._id.day);
  }
  const reconciled = recons.filter((r) => r.status === 'reconciled');
  const staffIds = [
    ...new Set([...taken.keys(), ...recons.map((r) => r.collectorId.toHexString())]),
  ];
  const overdueCollectorIds = worstCustomers.flatMap((c) =>
    c.assignedCollectorId ? [c.assignedCollectorId.toHexString()] : [],
  );
  const [users, roundSizes] = await Promise.all([
    UserModel.find({ _id: { $in: [...staffIds, ...overdueCollectorIds] } }, { name: 1, role: 1 }),
    CustomerModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { status: 'active', assignedCollectorId: { $ne: null }, ...NOT_TRASHED } },
      { $group: { _id: '$assignedCollectorId', count: { $sum: 1 } } },
    ]),
  ]);
  const userById = new Map(users.map((u) => [u._id.toHexString(), u]));
  const roundOf = new Map(roundSizes.map((r) => [r._id.toHexString(), r.count]));

  const staff = staffIds
    .map((id) => {
      const user = userById.get(id);
      const collector = user?.role === 'collector';
      const recorded = taken.get(id)?.recorded ?? 0;
      const mine = reconciled.filter((r) => r.collectorId.toHexString() === id);
      return {
        id,
        name: user?.name ?? 'Former staff',
        role: collector ? ('collector' as const) : ('teller' as const),
        recorded,
        // A collector's cash is confirmed when the office counts it on
        // handover; money taken at the office is in the drawer as recorded.
        confirmed: collector ? sum(mine, (r) => r.receivedAmount ?? 0) : recorded,
        customers: roundOf.get(id) ?? 0,
        daysReconciled: mine.length,
        daysWorked: taken.get(id)?.days.size ?? 0,
      };
    })
    .sort((a, b) => b.recorded - a.recorded);

  const handoverDays = Array.from({ length: 14 }, (_, i) =>
    accraDay(new Date(end.getTime() - (14 - i) * DAY_MS)),
  );
  const handoverRows = staff
    .filter((s) => s.role === 'collector')
    .map((s) => ({
      staffId: s.id,
      name: s.name,
      cells: handoverDays.map((day) => {
        const hit = reconciled.find(
          (r) => r.collectorId.toHexString() === s.id && r.accraDay === day,
        );
        return { day, variance: hit ? (hit.variance ?? 0) : null };
      }),
    }));

  // ---------------------------------------------------------------- customers
  const [susuHolders, savingsHolders] = await Promise.all([
    SusuAccountModel.distinct('customerId', { status: 'active', ...NOT_TRASHED }),
    SavingsAccountModel.distinct('customerId', { status: 'active', ...NOT_TRASHED }),
  ]);
  const withSusu = new Set(susuHolders.map((id) => id.toHexString()));
  const withSavings = new Set(savingsHolders.map((id) => id.toHexString()));
  const both = [...withSusu].filter((id) => withSavings.has(id)).length;
  let existing = customersBefore;
  const customerMonths = months.map((m) => {
    const joinedIn = joined.find((j) => j._id === m.key)?.count ?? 0;
    existing += joinedIn;
    return {
      ...m,
      joined: joinedIn,
      dormant: deactivated.find((d) => d._id === m.key)?.count ?? 0,
      active: existing,
    };
  });

  // ---------------------------------------------------------------- revenue
  const revenue = months.map((m, i) => {
    const r = revenueByMonth[i];
    return {
      ...m,
      susuCommission: r?.earned.susuCommission.amount ?? 0,
      savingsFees: (r?.earned.savingsFees.amount ?? 0) + (r?.earned.loanProcessingFees.amount ?? 0),
      loanInterest: r?.interest.total ?? 0,
      salesMargin: r?.earned.outrightSalesProfit.amount ?? 0,
    };
  });
  const revenueOf = (m: (typeof revenue)[number]): number =>
    m.susuCommission + m.savingsFees + m.loanInterest + m.salesMargin;

  // The running month against the same number of days of the month before, so
  // a part month is not read as a fall.
  const lastIdx = months.length - 1;
  const dayOfMonth = Number(to.slice(8, 10));
  const prevKey = months[lastIdx - 1]?.key ?? '';
  const prevDays = prevKey ? new Date(monthEnd(prevKey).getTime() - DAY_MS).getUTCDate() : 30;
  const share = Math.min(1, dayOfMonth / prevDays);
  const depositsOf = (i: number): number =>
    (susuMonths[i]?.inflow ?? 0) + (savingsMonths[i]?.inflow ?? 0);
  const prevRevenue = revenue[lastIdx - 1];
  const lastRevenue = revenue[lastIdx];

  return {
    period,
    from,
    to,
    generatedAt: new Date().toISOString(),
    kpis: {
      depositsMobilised: sum(susuMonths, (m) => m.inflow) + sum(savingsMonths, (m) => m.inflow),
      depositsDelta: change(depositsOf(lastIdx), depositsOf(lastIdx - 1) * share),
      withdrawalsPaid: sum(susuMonths, (m) => m.outflow) + sum(savingsMonths, (m) => m.outflow),
      loansDisbursed: sum(loanMonths, (m) => m.outflow),
      loansCount: countOf(LOANS_OUT, 'out'),
      par30,
      par30Delta: (parTrend[lastIdx] ?? 0) - (parTrend[lastIdx - 1] ?? 0),
      revenue: sum(revenue, revenueOf),
      revenueDelta: change(
        lastRevenue ? revenueOf(lastRevenue) : 0,
        (prevRevenue ? revenueOf(prevRevenue) : 0) * share,
      ),
      handoverVariance: sum(reconciled, (r) => r.variance ?? 0),
      handoverDays: reconciled.length,
    },
    flow,
    susu: {
      accounts: susuOpen[0]?.count ?? 0,
      valueHeld: susuOpen[0]?.balance ?? 0,
      collectedPerDay,
      cycles: [
        { label: 'Payments 1–10', count: stage(1, 10) },
        { label: 'Payments 11–20', count: stage(11, 20) },
        { label: 'Payments 21–30', count: stage(21, 30) },
        { label: 'Between cycles', count: stage(0, 0) },
        { label: 'Completed this period', count: completed },
      ],
      payoutsDue: { count: completed, amount: cyclesEnded[0]?.commission ?? 0 },
      months: susuMonths,
    },
    savings: {
      accounts: savingsOpen[0]?.count ?? 0,
      balance: savingsBalance,
      months: savingsMonths,
      balances,
    },
    loans: {
      open: openLoans.length,
      outstanding,
      months: loanMonths,
      parTrend,
      aging,
      overdue: worst.map(({ loan, days }) => {
        const customer = customerById.get(loan.customerId.toHexString());
        const collector = customer?.assignedCollectorId
          ? userById.get(customer.assignedCollectorId.toHexString())?.name
          : undefined;
        return {
          id: loan.accountNumber ?? loan._id.toHexString().slice(-8).toUpperCase(),
          customer: customer?.fullName ?? 'Customer',
          principal: loan.principal,
          remaining: loan.totalDue - loan.totalRepaid,
          daysOverdue: days,
          collector: collector ?? '—',
        };
      }),
    },
    hp: {
      contracts: openHp.length,
      outstanding: sum(openHp, (a) => remainingOn(a)),
      statuses: [
        standing('Paying on time', 'active'),
        standing('Behind', 'in-arrears'),
        standing('Repossessed', 'repossessed'),
        { label: 'Settled this period', count: hpSettled, amount: 0 },
      ],
    },
    sales: {
      receipts: sales.length,
      total: sum(sales, (s) => s.total),
      voided,
      categories: [...byCategory.values()].sort((a, b) => b.outright + b.hp - (a.outright + a.hp)),
    },
    staff,
    handover: { days: handoverDays, rows: handoverRows },
    customers: {
      total: customersActive,
      months: customerMonths,
      byProduct: [
        { label: 'Susu only', count: withSusu.size - both },
        { label: 'Savings only', count: withSavings.size - both },
        { label: 'Susu + savings', count: both },
        {
          label: 'With a loan',
          count: new Set(openLoans.map((l) => l.customerId.toHexString())).size,
        },
        {
          label: 'Hire purchase',
          count: new Set(openHp.map((a) => a.customerId.toHexString())).size,
        },
      ],
    },
    revenue,
  };
}
