import { Types } from 'mongoose';
import { AppError } from '../../lib/errors.js';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  ReconciliationModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  UserModel,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { remainingDeposits } from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';

/**
 * The field collector's two screens: what still has to be collected today, and
 * what has been collected so far.
 *
 * Both are pinned to the acting collector. Office roles may inspect any
 * collector by passing collectorId — the same rule the reconciliation and susu
 * summary endpoints already follow.
 */

export interface CollectorSummary {
  id: string;
  name: string;
}

/**
 * The roster: who is out collecting, for the counter to assign a round to.
 *
 * Deliberately not `GET /users`. That is the staff directory — every account,
 * with its role and whether it is disabled — and it is the office's. What the
 * counter needs when registering a customer is narrower and different in kind:
 * the names of the people whose rounds a customer can join, and nothing else.
 * Opening the directory to tellers to answer that question would hand them the
 * whole staff list to get at a roster.
 *
 * Active only. A disabled collector has no round to join.
 */
export async function listCollectors(): Promise<CollectorSummary[]> {
  const collectors = await UserModel.find(
    { role: 'collector', status: 'active' },
    { name: 1 },
  ).sort({ name: 1 });
  return collectors.map((c) => ({ id: c._id.toHexString(), name: c.name }));
}

/** Office may inspect anyone; a collector is always pinned to themselves. */
function resolveCollectorId(
  actor: AccessTokenPayload,
  requested: Types.ObjectId | undefined,
): Types.ObjectId {
  if (actor.role === 'collector') return new Types.ObjectId(actor.sub);
  if (!requested) {
    throw new AppError('COLLECTOR_REQUIRED', 'Specify collectorId when not a collector', 422);
  }
  return requested;
}

export interface RoundStop {
  customerId: string;
  customerName: string;
  phone: string;
  /** Where to find them, when the record has it. */
  residentialAddress?: string;
  photoUrl?: string;
  susu: {
    accountId: string;
    accountNumber: string;
    dailyAmount: number;
    /** Deposits recorded so far in the 31-day cycle. */
    depositsCount: number;
    daysRemainingInCycle: number;
    /** Pesewas already taken for this account today (0 when not yet visited). */
    collectedToday: number;
    /** One day's deposit, less anything already taken today. Never negative. */
    stillDue: number;
  }[];
  /** Sum of stillDue across the customer's susu accounts. */
  totalStillDue: number;
  /** True once every susu account has today's deposit recorded. */
  done: boolean;
}

export interface CollectorRound {
  date: string;
  collectorId: string;
  stops: RoundStop[];
  totals: {
    customers: number;
    customersDone: number;
    susuAccounts: number;
    /** What a full round would bring in: one day's deposit per open account. */
    expectedTotal: number;
    collectedTotal: number;
    stillDueTotal: number;
  };
}

/**
 * Who still owes today's susu deposit.
 *
 * Susu is the only product with a daily schedule — savings deposits are
 * voluntary and loans/HP are collected at the office, so neither can be "due"
 * on a round. Completed cycles are excluded: a 31st deposit cannot be taken.
 */
export async function collectorRound(
  actor: AccessTokenPayload,
  date: string | undefined,
  requestedCollectorId: Types.ObjectId | undefined,
): Promise<CollectorRound> {
  const day = date ?? accraDay();
  const collectorId = resolveCollectorId(actor, requestedCollectorId);
  // Ghana is UTC+0, so the Accra day is exactly the UTC day.
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const customers = await CustomerModel.find(
    { assignedCollectorId: collectorId, status: 'active', ...NOT_TRASHED },
    {
      fullName: 1,
      phone: 1,
      residentialAddress: 1,
      photoUrl: 1,
    },
  ).sort({ fullName: 1 });

  if (customers.length === 0) {
    return {
      date: day,
      collectorId: collectorId.toHexString(),
      stops: [],
      totals: {
        customers: 0,
        customersDone: 0,
        susuAccounts: 0,
        expectedTotal: 0,
        collectedTotal: 0,
        stillDueTotal: 0,
      },
    };
  }

  const customerIds = customers.map((c) => c._id);
  const accounts = await SusuAccountModel.find({
    customerId: { $in: customerIds },
    status: 'active',
    ...NOT_TRASHED,
  });

  // What has already been taken today, per account. Any collector's deposit
  // counts: the day is satisfied regardless of who recorded it.
  const takenRows = await SusuDepositModel.aggregate<{ _id: Types.ObjectId; amount: number }>([
    {
      $match: {
        accountId: { $in: accounts.map((a) => a._id) },
        createdAt: { $gte: start, $lt: end },
        ...NOT_TRASHED,
      },
    },
    { $group: { _id: '$accountId', amount: { $sum: '$amount' } } },
  ]);
  const takenByAccount = new Map(takenRows.map((r) => [r._id.toHexString(), r.amount]));

  const byCustomer = new Map<string, RoundStop['susu']>();
  for (const account of accounts) {
    const collectedToday = takenByAccount.get(account._id.toHexString()) ?? 0;
    const key = account.customerId.toHexString();
    const list = byCustomer.get(key) ?? [];
    list.push({
      accountId: account._id.toHexString(),
      accountNumber: account.accountNumber,
      dailyAmount: account.dailyAmount,
      depositsCount: account.depositsCount,
      daysRemainingInCycle: remainingDeposits(account.depositsCount),
      collectedToday,
      stillDue: Math.max(0, account.dailyAmount - collectedToday),
    });
    byCustomer.set(key, list);
  }

  const stops: RoundStop[] = customers
    .map((customer) => {
      const susu = byCustomer.get(customer._id.toHexString()) ?? [];
      const totalStillDue = susu.reduce((sum, a) => sum + a.stillDue, 0);
      return {
        customerId: customer._id.toHexString(),
        customerName: customer.fullName,
        phone: customer.phone,
        ...(customer.residentialAddress !== undefined
          ? { residentialAddress: customer.residentialAddress }
          : {}),
        ...(customer.photoUrl !== undefined ? { photoUrl: customer.photoUrl } : {}),
        susu,
        totalStillDue,
        done: susu.length > 0 && totalStillDue === 0,
      };
    })
    // A customer with no open susu account has nothing to collect today.
    .filter((stop) => stop.susu.length > 0);

  const allAccounts = stops.flatMap((s) => s.susu);
  return {
    date: day,
    collectorId: collectorId.toHexString(),
    stops,
    totals: {
      customers: stops.length,
      customersDone: stops.filter((s) => s.done).length,
      susuAccounts: allAccounts.length,
      expectedTotal: allAccounts.reduce((sum, a) => sum + a.dailyAmount, 0),
      collectedTotal: allAccounts.reduce((sum, a) => sum + a.collectedToday, 0),
      stillDueTotal: allAccounts.reduce((sum, a) => sum + a.stillDue, 0),
    },
  };
}

export interface CollectorDayEntry {
  id: string;
  product: 'susu' | 'savings';
  accountId: string;
  accountNumber: string;
  customerId: string;
  customerName: string;
  amount: number;
  channel: string;
  at: Date;
}

export interface CollectorDay {
  date: string;
  collectorId: string;
  susu: { count: number; amount: number };
  savings: { count: number; amount: number };
  /** Cash the collector is holding for handover: susu + savings, cash only. */
  cashTotal: number;
  entries: CollectorDayEntry[];
  /** Set once the collector has declared this day; null while still open. */
  reconciliation: { id: string; status: string; declaredAmount: number } | null;
}

/**
 * Everything the collector took in today, across both field products.
 *
 * `cashTotal` counts CASH only, matching what reconciliation expects them to
 * hand over — a Paystack deposit they recorded is real money but never lands
 * in their pocket (see reconciliation.service.ts).
 */
export async function collectorDay(
  actor: AccessTokenPayload,
  date: string | undefined,
  requestedCollectorId: Types.ObjectId | undefined,
): Promise<CollectorDay> {
  const day = date ?? accraDay();
  const collectorId = resolveCollectorId(actor, requestedCollectorId);
  const start = new Date(`${day}T00:00:00.000Z`);
  const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  const [susuDeposits, savingsTxns, reconciliation] = await Promise.all([
    SusuDepositModel.find({
      collectorId,
      createdAt: { $gte: start, $lt: end },
      ...NOT_TRASHED,
    }).sort({ createdAt: 1 }),
    SavingsTxnModel.find({
      recordedById: collectorId,
      type: 'deposit',
      accraDay: day,
      ...NOT_TRASHED,
    }).sort({ createdAt: 1 }),
    ReconciliationModel.findOne({ collectorId, accraDay: day }),
  ]);

  const customerIds = new Set<string>();
  for (const d of susuDeposits) customerIds.add(d.customerId.toHexString());
  for (const t of savingsTxns) customerIds.add(t.customerId.toHexString());

  const [customers, susuAccounts, savingsAccounts] = await Promise.all([
    CustomerModel.find({ _id: { $in: [...customerIds] } }, { fullName: 1 }),
    SusuAccountModel.find(
      { _id: { $in: susuDeposits.map((d) => d.accountId) } },
      { accountNumber: 1 },
    ),
    SavingsAccountModel.find(
      { _id: { $in: savingsTxns.map((t) => t.accountId) } },
      { accountNumber: 1 },
    ),
  ]);
  const nameById = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  const numberById = new Map(
    [...susuAccounts, ...savingsAccounts].map((a) => [a._id.toHexString(), a.accountNumber]),
  );

  const entries: CollectorDayEntry[] = [
    ...susuDeposits.map((d) => ({
      id: d._id.toHexString(),
      product: 'susu' as const,
      accountId: d.accountId.toHexString(),
      accountNumber: numberById.get(d.accountId.toHexString()) ?? '',
      customerId: d.customerId.toHexString(),
      customerName: nameById.get(d.customerId.toHexString()) ?? '',
      amount: d.amount,
      channel: d.channel,
      at: d.createdAt,
    })),
    ...savingsTxns.map((t) => ({
      id: t._id.toHexString(),
      product: 'savings' as const,
      accountId: t.accountId.toHexString(),
      accountNumber: numberById.get(t.accountId.toHexString()) ?? '',
      customerId: t.customerId.toHexString(),
      customerName: nameById.get(t.customerId.toHexString()) ?? '',
      amount: t.amount,
      channel: t.channel,
      at: t.createdAt,
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());

  const cashOnly = entries.filter((e) => e.channel === 'cash');
  return {
    date: day,
    collectorId: collectorId.toHexString(),
    susu: {
      count: susuDeposits.length,
      amount: susuDeposits.reduce((sum, d) => sum + d.amount, 0),
    },
    savings: {
      count: savingsTxns.length,
      amount: savingsTxns.reduce((sum, t) => sum + t.amount, 0),
    },
    cashTotal: cashOnly.reduce((sum, e) => sum + e.amount, 0),
    entries,
    reconciliation: reconciliation
      ? {
          id: reconciliation._id.toHexString(),
          status: reconciliation.status,
          declaredAmount: reconciliation.declaredAmount,
        }
      : null,
  };
}
