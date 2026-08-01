import { Types } from 'mongoose';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  LoanModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
} from '../../models/index.js';

/** Inclusive Accra-day range → UTC window (Ghana is UTC+0 year-round). */
export function rangeToWindow(
  from?: string,
  to?: string,
): { from: string; to: string; start: Date; end: Date } {
  const toDay = to ?? accraDay();
  const fromDay = from ?? accraDay(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
  return {
    from: fromDay,
    to: toDay,
    start: new Date(`${fromDay}T00:00:00.000Z`),
    end: new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() + 24 * 60 * 60 * 1000),
  };
}

// ---------------------------------------------------------------- collections by staff

export interface StaffCollectionsRow {
  userId: string;
  name: string;
  role: string;
  susuCount: number;
  susuAmount: number;
  savingsCount: number;
  savingsAmount: number;
  totalAmount: number;
}

export async function collectionsByStaff(
  from?: string,
  to?: string,
): Promise<{ from: string; to: string; rows: StaffCollectionsRow[]; totalAmount: number }> {
  const window = rangeToWindow(from, to);
  const createdAt = { $gte: window.start, $lt: window.end };

  const [susu, savings] = await Promise.all([
    SusuDepositModel.aggregate<{ _id: Types.ObjectId; count: number; amount: number }>([
      { $match: { createdAt } },
      { $group: { _id: '$collectorId', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
    SavingsTxnModel.aggregate<{ _id: Types.ObjectId; count: number; amount: number }>([
      { $match: { createdAt, type: 'deposit' } },
      { $group: { _id: '$recordedById', count: { $sum: 1 }, amount: { $sum: '$amount' } } },
    ]),
  ]);

  const byUser = new Map<string, StaffCollectionsRow>();
  const ensure = (id: Types.ObjectId): StaffCollectionsRow => {
    const key = id.toHexString();
    let row = byUser.get(key);
    if (!row) {
      row = {
        userId: key,
        name: '',
        role: '',
        susuCount: 0,
        susuAmount: 0,
        savingsCount: 0,
        savingsAmount: 0,
        totalAmount: 0,
      };
      byUser.set(key, row);
    }
    return row;
  };
  for (const s of susu) {
    const row = ensure(s._id);
    row.susuCount = s.count;
    row.susuAmount = s.amount;
  }
  for (const s of savings) {
    const row = ensure(s._id);
    row.savingsCount = s.count;
    row.savingsAmount = s.amount;
  }

  const users = await UserModel.find({ _id: { $in: [...byUser.keys()] } }, { name: 1, role: 1 });
  for (const u of users) {
    const row = byUser.get(u._id.toHexString());
    if (row) {
      row.name = u.name;
      row.role = u.role;
    }
  }
  const rows = [...byUser.values()]
    .map((r) => ({ ...r, totalAmount: r.susuAmount + r.savingsAmount }))
    .sort((a, b) => b.totalAmount - a.totalAmount);

  return {
    from: window.from,
    to: window.to,
    rows,
    totalAmount: rows.reduce((sum, r) => sum + r.totalAmount, 0),
  };
}

// ---------------------------------------------------------------- outstanding loans

export interface OutstandingLoanRow {
  loanId: string;
  customerId: string;
  customerName: string;
  tier: string;
  status: string;
  principal: number;
  ratePercent: number;
  totalDue: number;
  totalRepaid: number;
  remaining: number;
  dueDate: Date | null;
  daysOverdue: number;
  frozen: boolean;
}

export async function outstandingLoans(): Promise<{
  rows: OutstandingLoanRow[];
  totalRemaining: number;
}> {
  const loans = await LoanModel.find({ status: { $in: ['active', 'arrears'] } }).sort({
    dueDate: 1,
  });
  const names = new Map(
    (
      await CustomerModel.find(
        { _id: { $in: [...new Set(loans.map((l) => l.customerId.toHexString()))] } },
        { fullName: 1 },
      )
    ).map((c) => [c._id.toHexString(), c.fullName]),
  );
  const now = Date.now();
  const rows = loans.map((l) => ({
    loanId: l._id.toHexString(),
    customerId: l.customerId.toHexString(),
    customerName: names.get(l.customerId.toHexString()) ?? '',
    tier: l.tier,
    status: l.status,
    principal: l.principal,
    ratePercent: l.ratePercent,
    totalDue: l.totalDue,
    totalRepaid: l.totalRepaid,
    remaining: l.totalDue - l.totalRepaid,
    dueDate: l.dueDate ?? null,
    daysOverdue: l.dueDate ? Math.max(0, Math.floor((now - l.dueDate.getTime()) / 86_400_000)) : 0,
    frozen: l.frozen,
  }));
  return { rows, totalRemaining: rows.reduce((sum, r) => sum + r.remaining, 0) };
}

// ---------------------------------------------------------------- arrears aging

export interface AgingBucket {
  bucket: string;
  count: number;
  totalRemaining: number;
}

export async function arrearsAging(): Promise<{
  buckets: AgingBucket[];
  rows: (OutstandingLoanRow & { bucket: string })[];
}> {
  const { rows } = await outstandingLoans();
  const overdue = rows.filter((r) => r.daysOverdue > 0);
  const bucketOf = (days: number): string => (days <= 30 ? '1-30' : days <= 90 ? '31-90' : '90+');
  const withBucket = overdue.map((r) => ({ ...r, bucket: bucketOf(r.daysOverdue) }));
  const buckets = ['1-30', '31-90', '90+'].map((bucket) => {
    const inBucket = withBucket.filter((r) => r.bucket === bucket);
    return {
      bucket,
      count: inBucket.length,
      totalRemaining: inBucket.reduce((sum, r) => sum + r.remaining, 0),
    };
  });
  return { buckets, rows: withBucket };
}

// ---------------------------------------------------------------- commission earned

export interface CommissionReport {
  from: string;
  to: string;
  susuCommission: { count: number; amount: number };
  savingsFees: { count: number; amount: number };
  totalRevenue: number;
}

export async function commissionEarned(from?: string, to?: string): Promise<CommissionReport> {
  const window = rangeToWindow(from, to);

  const [susu, savings] = await Promise.all([
    SusuAccountModel.aggregate<{ count: number; amount: number }>([
      {
        $match: {
          status: 'closed',
          closedAt: { $gte: window.start, $lt: window.end },
          commissionAmount: { $gt: 0 },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$commissionAmount' } } },
    ]),
    SavingsTxnModel.aggregate<{ count: number; amount: number }>([
      {
        $match: {
          createdAt: { $gte: window.start, $lt: window.end },
          type: { $in: ['withdrawal', 'closure'] },
          fee: { $gt: 0 },
        },
      },
      { $group: { _id: null, count: { $sum: 1 }, amount: { $sum: '$fee' } } },
    ]),
  ]);

  const susuCommission = { count: susu[0]?.count ?? 0, amount: susu[0]?.amount ?? 0 };
  const savingsFees = { count: savings[0]?.count ?? 0, amount: savings[0]?.amount ?? 0 };
  return {
    from: window.from,
    to: window.to,
    susuCommission,
    savingsFees,
    totalRevenue: susuCommission.amount + savingsFees.amount,
  };
}
