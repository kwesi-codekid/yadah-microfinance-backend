import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { generateAccountNumber, SUSU_ACCOUNT_DIGITS } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  SusuAccountModel,
  SusuDepositModel,
  type Customer,
  type SusuAccount,
  type SusuDeposit,
} from '../../models/index.js';
import {
  SUSU_CYCLE_DEPOSITS,
  computeClosure,
  computeDepositAmount,
  remainingDeposits,
} from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { Channel } from '../../models/shared.js';
import type { ListAccountsQuery, ListDepositsQuery, SummaryQuery } from './susu.schemas.js';

// ---------------------------------------------------------------- shapes

export interface PublicSusuAccount {
  id: string;
  accountNumber: string;
  customerId: string;
  /** Present on list responses for display; joined from the customer. */
  customerName?: string;
  dailyAmount: number;
  depositsCount: number;
  cycleTarget: number;
  totalDeposited: number;
  status: 'active' | 'completed' | 'closed';
  commissionAmount?: number;
  payoutAmount?: number;
  openedAt: Date;
  closedAt?: Date;
}

export function toPublicAccount(a: SusuAccount): PublicSusuAccount {
  return {
    id: a._id.toHexString(),
    accountNumber: a.accountNumber,
    customerId: a.customerId.toHexString(),
    dailyAmount: a.dailyAmount,
    depositsCount: a.depositsCount,
    cycleTarget: SUSU_CYCLE_DEPOSITS,
    totalDeposited: a.totalDeposited,
    status: a.status,
    ...(a.commissionAmount !== undefined ? { commissionAmount: a.commissionAmount } : {}),
    ...(a.payoutAmount !== undefined ? { payoutAmount: a.payoutAmount } : {}),
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
  };
}

export interface PublicDeposit {
  id: string;
  accountId: string;
  customerId: string;
  collectorId: string;
  amount: number;
  daysCovered: number;
  seqStart: number;
  seqEnd: number;
  channel: string;
  collectAllBatchId?: string;
  createdAt: Date;
}

function toPublicDeposit(d: SusuDeposit): PublicDeposit {
  return {
    id: d._id.toHexString(),
    accountId: d.accountId.toHexString(),
    customerId: d.customerId.toHexString(),
    collectorId: d.collectorId.toHexString(),
    amount: d.amount,
    daysCovered: d.daysCovered,
    seqStart: d.seqStart,
    seqEnd: d.seqEnd,
    channel: d.channel,
    ...(d.collectAllBatchId ? { collectAllBatchId: d.collectAllBatchId.toHexString() } : {}),
    createdAt: d.createdAt,
  };
}

// ---------------------------------------------------------------- helpers

async function loadCustomer(customerId: Types.ObjectId): Promise<Customer> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return customer;
}

// ---------------------------------------------------------------- accounts

export async function openAccount(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  dailyAmount: number,
  requestId?: string,
): Promise<PublicSusuAccount> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }

  let account;
  for (let attempt = 0; ; attempt++) {
    try {
      account = await SusuAccountModel.create({
        accountNumber: generateAccountNumber(SUSU_ACCOUNT_DIGITS),
        customerId,
        dailyAmount,
        openedById: new Types.ObjectId(actor.sub),
      });
      break;
    } catch (err) {
      // Rare random collision on the unique account number — regenerate.
      if (err instanceof MongoServerError && err.code === 11000 && attempt < 5) continue;
      throw err;
    }
  }

  await audit({
    actorId: actor.sub,
    action: 'susu.account.open',
    entityType: 'susu-account',
    entityId: account._id,
    after: { dailyAmount, customerId: customerId.toHexString() },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.account.opened', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    dailyAmount,
  });
  return toPublicAccount(account);
}

export interface AccountList {
  items: PublicSusuAccount[];
  page: number;
  limit: number;
  total: number;
}

export async function listAccounts(
  _actor: AccessTokenPayload,
  query: ListAccountsQuery,
): Promise<AccountList> {
  const filter: Record<string, unknown> = {};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.accountNumber !== undefined) filter.accountNumber = query.accountNumber;

  // Fuzzy: match by customer (typo-tolerant name/phone) or account number prefix.
  if (query.search !== undefined) {
    const customerIds = await fuzzyCustomerIds(query.search);
    const or: Record<string, unknown>[] = [{ customerId: { $in: customerIds } }];
    if (/^\d{2,6}$/.test(query.search)) {
      or.push({ accountNumber: { $regex: `^${query.search}` } });
    }
    filter.$or = or;
  }

  const [accounts, total] = await Promise.all([
    SusuAccountModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuAccountModel.countDocuments(filter),
  ]);

  const names = await customerNamesById(accounts.map((a) => a.customerId));
  const items = accounts.map((a) => ({
    ...toPublicAccount(a),
    customerName: names.get(a.customerId.toHexString()) ?? '',
  }));
  return { items, page: query.page, limit: query.limit, total };
}

/** One page-sized join for display names. */
async function customerNamesById(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map((id) => id.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  return new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
}

export async function getAccount(
  _actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSusuAccount> {
  const account = await SusuAccountModel.findById(id);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  return toPublicAccount(account);
}

export async function listAccountDeposits(
  _actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListDepositsQuery,
): Promise<{ items: PublicDeposit[]; page: number; limit: number; total: number }> {
  const account = await SusuAccountModel.findById(accountId);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);

  const [deposits, total] = await Promise.all([
    SusuDepositModel.find({ accountId })
      .sort({ seqStart: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuDepositModel.countDocuments({ accountId }),
  ]);
  return { items: deposits.map(toPublicDeposit), page: query.page, limit: query.limit, total };
}

// ---------------------------------------------------------------- deposits

export interface DepositResult {
  deposit: PublicDeposit;
  account: PublicSusuAccount;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

export async function recordDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  daysCovered: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<DepositResult> {
  // Replay of a retried mobile request → return the original, write nothing.
  const existing = await SusuDepositModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SusuAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return {
      deposit: toPublicDeposit(existing),
      account: toPublicAccount(account),
      replayed: true,
    };
  }

  const accountPre = await SusuAccountModel.findById(accountId);
  if (!accountPre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const customer = await loadCustomer(accountPre.customerId);

  const session = await mongoose.startSession();
  let deposit!: SusuDeposit;
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({ _id: accountId, status: 'active' }).session(
        session,
      );
      if (!account) {
        throw new AppError(
          'ACCOUNT_NOT_ACTIVE',
          'Deposits are only allowed on active accounts',
          422,
        );
      }
      const remaining = remainingDeposits(account.depositsCount);
      if (daysCovered > remaining) {
        throw new AppError(
          'EXCEEDS_REMAINING',
          `Only ${String(remaining)} deposit day(s) remain in this cycle`,
          422,
          { remaining },
        );
      }

      const amount = computeDepositAmount(account.dailyAmount, daysCovered);
      const completed = account.depositsCount + daysCovered === SUSU_CYCLE_DEPOSITS;

      // Optimistic concurrency: the counters must not have moved since we read them.
      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: 'active', depositsCount: account.depositsCount },
        {
          $inc: { depositsCount: daysCovered, totalDeposited: amount },
          ...(completed ? { $set: { status: 'completed' } } : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      const [created] = await SusuDepositModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            collectorId: new Types.ObjectId(actor.sub),
            amount,
            daysCovered,
            seqStart: account.depositsCount + 1,
            seqEnd: account.depositsCount + daysCovered,
            channel,
            idempotencyKey,
          },
        ],
        { session },
      );
      deposit = created as SusuDeposit;

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.record',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: account.totalDeposited,
          amountAfter: account.totalDeposited + amount,
          after: {
            daysCovered,
            seq: `${String(account.depositsCount + 1)}-${String(account.depositsCount + daysCovered)}`,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const reloaded = await SusuAccountModel.findById(accountId);
  if (!reloaded) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const accountAfter = reloaded;

  // Post-commit, fire-and-forget: receipt + live feed.
  await enqueueSms({
    to: customer.phone,
    template: 'susu-deposit-receipt',
    message:
      `Yadah: ${formatGhs(deposit.amount)} received on susu acct ${accountAfter.accountNumber}. ` +
      `Progress: ${String(deposit.seqEnd)}/${String(SUSU_CYCLE_DEPOSITS)}. ` +
      `Total saved: ${formatGhs(accountAfter.totalDeposited)}.`,
    relatedEntityType: 'susu-deposit',
    relatedEntityId: deposit._id,
  });
  emitAdminEvent('susu.deposit.recorded', {
    accountId: accountId.toHexString(),
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    amount: deposit.amount,
    progress: `${String(deposit.seqEnd)}/${String(SUSU_CYCLE_DEPOSITS)}`,
    completed: accountAfter.status === 'completed',
  });

  return {
    deposit: toPublicDeposit(deposit),
    account: toPublicAccount(accountAfter),
    replayed: false,
  };
}

// ---------------------------------------------------------------- collect-all

export interface CollectAllResult {
  batchId: string;
  totalAmount: number;
  deposits: PublicDeposit[];
  accounts: PublicSusuAccount[];
  replayed: boolean;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export async function collectAll(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<CollectAllResult> {
  const customer = await loadCustomer(customerId);

  // Replay: per-account keys are derived as `${key}#${n}` — any hit means done.
  const prior = await SusuDepositModel.find({
    idempotencyKey: { $regex: `^${escapeRegex(idempotencyKey)}#` },
  });
  if (prior.length > 0) {
    const accountIds = prior.map((d) => d.accountId);
    const accounts = await SusuAccountModel.find({ _id: { $in: accountIds } });
    return {
      batchId: prior[0]?.collectAllBatchId?.toHexString() ?? '',
      totalAmount: prior.reduce((sum, d) => sum + d.amount, 0),
      deposits: prior.map(toPublicDeposit),
      accounts: accounts.map(toPublicAccount),
      replayed: true,
    };
  }

  const active = await SusuAccountModel.find({ customerId, status: 'active' }).sort({
    createdAt: 1,
  });
  if (active.length === 0) {
    throw new AppError('NO_ACTIVE_ACCOUNTS', 'Customer has no active susu accounts', 422);
  }
  const required = active.reduce((sum, a) => sum + a.dailyAmount, 0);
  if (amount !== required) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `Collect-all must equal one day across all active accounts: ${formatGhs(required)}`,
      422,
      {
        required,
        breakdown: active.map((a) => ({
          accountId: a._id.toHexString(),
          dailyAmount: a.dailyAmount,
        })),
      },
    );
  }

  const batchId = new Types.ObjectId();
  const session = await mongoose.startSession();
  const created: SusuDeposit[] = [];
  try {
    await session.withTransaction(async () => {
      created.length = 0;
      for (const [i, pre] of active.entries()) {
        const account = await SusuAccountModel.findOne({ _id: pre._id, status: 'active' }).session(
          session,
        );
        if (!account) {
          throw new AppError('CONFLICT', 'An account changed while collecting — retry', 409);
        }
        const completed = account.depositsCount + 1 === SUSU_CYCLE_DEPOSITS;
        const upd = await SusuAccountModel.updateOne(
          { _id: account._id, status: 'active', depositsCount: account.depositsCount },
          {
            $inc: { depositsCount: 1, totalDeposited: account.dailyAmount },
            ...(completed ? { $set: { status: 'completed' } } : {}),
          },
          { session },
        );
        if (upd.modifiedCount !== 1) {
          throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
        }
        const [dep] = await SusuDepositModel.create(
          [
            {
              accountId: account._id,
              customerId,
              collectorId: new Types.ObjectId(actor.sub),
              amount: account.dailyAmount,
              daysCovered: 1,
              seqStart: account.depositsCount + 1,
              seqEnd: account.depositsCount + 1,
              channel,
              collectAllBatchId: batchId,
              idempotencyKey: `${idempotencyKey}#${String(i)}`,
            },
          ],
          { session },
        );
        created.push(dep as SusuDeposit);
        await audit(
          {
            actorId: actor.sub,
            action: 'susu.deposit.record',
            entityType: 'susu-account',
            entityId: account._id,
            amountBefore: account.totalDeposited,
            amountAfter: account.totalDeposited + account.dailyAmount,
            after: {
              collectAllBatchId: batchId.toHexString(),
              seq: String(account.depositsCount + 1),
            },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
      }
    });
  } finally {
    await session.endSession();
  }

  const accounts = await SusuAccountModel.find({ _id: { $in: active.map((a) => a._id) } });

  const numberById = new Map(active.map((a) => [a._id.toHexString(), a.accountNumber]));
  const lines = created
    .map(
      (d) =>
        `${numberById.get(d.accountId.toHexString()) ?? '??'}: ${formatGhs(d.amount)} ` +
        `(${String(d.seqEnd)}/${String(SUSU_CYCLE_DEPOSITS)})`,
    )
    .join(', ');
  await enqueueSms({
    to: customer.phone,
    template: 'susu-collect-all-receipt',
    message: `Yadah: ${formatGhs(amount)} received across ${String(created.length)} susu account(s): ${lines}.`,
    relatedEntityType: 'susu-deposit',
    relatedEntityId: batchId,
  });
  emitAdminEvent('susu.deposit.recorded', {
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    amount,
    collectAll: true,
    accountsCount: created.length,
  });

  return {
    batchId: batchId.toHexString(),
    totalAmount: amount,
    deposits: created.map(toPublicDeposit),
    accounts: accounts.map(toPublicAccount),
    replayed: false,
  };
}

// ---------------------------------------------------------------- closure

export interface ClosureResult {
  account: PublicSusuAccount;
  commission: number;
  payout: number;
  /** True when deposits did not cover the 1-day commission. */
  flagged: boolean;
}

export async function closeAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<ClosureResult> {
  const pre = await SusuAccountModel.findById(accountId);
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status === 'closed') {
    throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let result!: ClosureResult;
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: { $in: ['active', 'completed'] },
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);

      const { commission, payout, flagged } = computeClosure(
        account.totalDeposited,
        account.dailyAmount,
      );
      const now = new Date();
      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: account.status, totalDeposited: account.totalDeposited },
        {
          $set: {
            status: 'closed',
            closedAt: now,
            closedById: new Types.ObjectId(actor.sub),
            commissionAmount: commission,
            payoutAmount: payout,
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.account.close',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: account.totalDeposited,
          amountAfter: payout,
          after: { commission, payout, flagged, depositsCount: account.depositsCount },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );

      account.status = 'closed';
      account.closedAt = now;
      account.commissionAmount = commission;
      account.payoutAmount = payout;
      result = { account: toPublicAccount(account), commission, payout, flagged };
    });
  } finally {
    await session.endSession();
  }

  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-withdrawal',
      message:
        `Yadah: susu acct ${pre.accountNumber} has been closed. Payout: ${formatGhs(result.payout)} ` +
        `(commission ${formatGhs(result.commission)}). Please collect at the office.`,
      relatedEntityType: 'susu-account',
      relatedEntityId: accountId,
    });
  }
  emitAdminEvent('susu.account.closed', {
    id: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    payout: result.payout,
    commission: result.commission,
    flagged: result.flagged,
  });

  return result;
}

// ---------------------------------------------------------------- daily summary

export interface DailySummary {
  date: string;
  collectorId: string | null;
  depositCount: number;
  totalCollected: number;
  deposits: {
    depositId: string;
    accountId: string;
    customerId: string;
    customerName: string;
    collectorId: string;
    amount: number;
    daysCovered: number;
    at: Date;
  }[];
}

export async function dailySummary(
  actor: AccessTokenPayload,
  query: SummaryQuery,
): Promise<DailySummary> {
  const date = query.date ?? accraDay();
  // Ghana is UTC+0: the Accra day is exactly the UTC day.
  const from = new Date(`${date}T00:00:00.000Z`);
  const to = new Date(from.getTime() + 24 * 60 * 60 * 1000);

  const collectorId =
    actor.role === 'collector' ? new Types.ObjectId(actor.sub) : (query.collectorId ?? null);

  const filter: Record<string, unknown> = { createdAt: { $gte: from, $lt: to } };
  if (collectorId) filter.collectorId = collectorId;

  const deposits = await SusuDepositModel.find(filter).sort({ createdAt: 1 });
  const customers = await CustomerModel.find({
    _id: { $in: [...new Set(deposits.map((d) => d.customerId.toHexString()))] },
  }).select('fullName');
  const nameById = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));

  return {
    date,
    collectorId: collectorId ? collectorId.toHexString() : null,
    depositCount: deposits.length,
    totalCollected: deposits.reduce((sum, d) => sum + d.amount, 0),
    deposits: deposits.map((d) => ({
      depositId: d._id.toHexString(),
      accountId: d.accountId.toHexString(),
      customerId: d.customerId.toHexString(),
      customerName: nameById.get(d.customerId.toHexString()) ?? '',
      collectorId: d.collectorId.toHexString(),
      amount: d.amount,
      daysCovered: d.daysCovered,
      at: d.createdAt,
    })),
  };
}
