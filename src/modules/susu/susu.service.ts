import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { generateAccountNumber, SUSU_ACCOUNT_DIGITS } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import {
  CustomerModel,
  SusuAccountModel,
  SusuDepositModel,
  SusuPayoutModel,
  type Customer,
  type SusuAccount,
  type SusuDeposit,
} from '../../models/index.js';
import { SUSU_CYCLE_DEPOSITS, computeClosure, remainingDeposits } from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { NOT_TRASHED, requireDeletedAt, type Channel } from '../../models/shared.js';
import type {
  ListAccountsQuery,
  ListDepositsQuery,
  ListTrashQuery,
  SummaryQuery,
} from './susu.schemas.js';

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
  status: 'active' | 'completed' | 'pending-payout' | 'closed' | 'terminated';
  commissionAmount?: number;
  payoutAmount?: number;
  /** Undisbursed value awaiting withdrawal (pending-payout accounts). */
  payoutRemaining: number;
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
    payoutRemaining: a.payoutRemaining,
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
  };
}

/** Flat spreadsheet row for the accounts listing export (csv/xlsx). */
export function toSusuAccountExportRow(item: PublicSusuAccount): Record<string, unknown> {
  return {
    id: item.id,
    accountNumber: item.accountNumber,
    customerName: item.customerName ?? '',
    customerId: item.customerId,
    dailyAmount: item.dailyAmount,
    depositsCount: item.depositsCount,
    cycleTarget: item.cycleTarget,
    totalDeposited: item.totalDeposited,
    status: item.status,
    commissionAmount: item.commissionAmount ?? null,
    payoutAmount: item.payoutAmount ?? null,
    payoutRemaining: item.payoutRemaining,
    openedAt: item.openedAt,
    closedAt: item.closedAt ?? null,
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

/** Flat spreadsheet row for the deposit-history (statement) export (csv/xlsx). */
export function toSusuDepositExportRow(item: PublicDeposit): Record<string, unknown> {
  return {
    id: item.id,
    seqStart: item.seqStart,
    seqEnd: item.seqEnd,
    daysCovered: item.daysCovered,
    amount: item.amount,
    channel: item.channel,
    collectorId: item.collectorId,
    createdAt: item.createdAt,
  };
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
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
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
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.accountNumber !== undefined) filter.accountNumber = query.accountNumber;
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;

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
  const account = await SusuAccountModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  return toPublicAccount(account);
}

export async function listAccountDeposits(
  _actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListDepositsQuery,
): Promise<{ items: PublicDeposit[]; page: number; limit: number; total: number }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);

  const depositFilter: Record<string, unknown> = { accountId, ...NOT_TRASHED };
  const depositDateFilter = createdAtFilter(query.from, query.to);
  if (depositDateFilter) depositFilter.createdAt = depositDateFilter;
  const [deposits, total] = await Promise.all([
    SusuDepositModel.find(depositFilter)
      .sort({ seqStart: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuDepositModel.countDocuments(depositFilter),
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
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<DepositResult> {
  // Replay of a retried mobile request → return the original, write nothing.
  const existing = await SusuDepositModel.findOne({ idempotencyKey });
  if (existing) {
    if (existing.deletedAt) {
      throw new AppError(
        'CONFLICT',
        'The original deposit was moved to the trash — use a new idempotency key',
        409,
      );
    }
    const account = await SusuAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return {
      deposit: toPublicDeposit(existing),
      account: toPublicAccount(account),
      replayed: true,
    };
  }

  const accountPre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!accountPre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  // dailyAmount is immutable, so the days covered can be derived pre-transaction.
  if (amount % accountPre.dailyAmount !== 0) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `Susu deposits must be a multiple of the daily amount (${formatGhs(accountPre.dailyAmount)})`,
      422,
      { dailyAmount: accountPre.dailyAmount },
    );
  }
  const daysCovered = amount / accountPre.dailyAmount;
  const customer = await loadCustomer(accountPre.customerId);

  const session = await mongoose.startSession();
  let deposit!: SusuDeposit;
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
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
  if (prior.some((d) => d.deletedAt)) {
    throw new AppError(
      'CONFLICT',
      'The original collection was moved to the trash — use a new idempotency key',
      409,
    );
  }
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

  const active = await SusuAccountModel.find({
    customerId,
    status: 'active',
    ...NOT_TRASHED,
  }).sort({
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
        const account = await SusuAccountModel.findOne({
          _id: pre._id,
          status: 'active',
          ...NOT_TRASHED,
        }).session(session);
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
  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status === 'closed' || pre.status === 'terminated') {
    throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
  }
  if (pre.totalDeposited < pre.dailyAmount) {
    throw new AppError(
      'COMMISSION_NOT_COVERED',
      'Deposits do not cover the one-day commission — use terminate to refund the balance',
      422,
      { totalDeposited: pre.totalDeposited, dailyAmount: pre.dailyAmount },
    );
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let result!: ClosureResult;
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: { $in: ['active', 'completed'] },
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
      if (account.totalDeposited < account.dailyAmount) {
        throw new AppError(
          'COMMISSION_NOT_COVERED',
          'Deposits do not cover the one-day commission — use terminate to refund the balance',
          422,
          { totalDeposited: account.totalDeposited, dailyAmount: account.dailyAmount },
        );
      }

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

      // The cash disbursement itself — without this row an office closure
      // would be invisible in the unified transactions feed.
      if (payout > 0) {
        await SusuPayoutModel.create(
          [
            {
              accountId: account._id,
              customerId: account.customerId,
              amount: payout,
              destination: 'cash',
              recordedById: new Types.ObjectId(actor.sub),
              idempotencyKey: `close:${account._id.toHexString()}`,
            },
          ],
          { session },
        );
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

// ---------------------------------------------------------------- terminate

export interface TerminationResult {
  account: PublicSusuAccount;
  refund: number;
}

/**
 * Escape hatch for accounts that cannot be closed normally because their
 * deposits do not cover the one-day commission (including empty accounts).
 * Refunds everything deposited, charges nothing.
 */
export async function terminateAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<TerminationResult> {
  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status === 'closed' || pre.status === 'terminated') {
    throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
  }
  if (pre.status !== 'active' && pre.status !== 'completed') {
    throw new AppError('CANNOT_TERMINATE', `Account is ${pre.status} — pay it out instead`, 422);
  }
  if (pre.totalDeposited >= pre.dailyAmount) {
    throw new AppError(
      'CANNOT_TERMINATE',
      'Deposits cover the one-day commission — close the account instead',
      422,
      { totalDeposited: pre.totalDeposited, dailyAmount: pre.dailyAmount },
    );
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let refund = 0;
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: { $in: ['active', 'completed'] },
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
      refund = account.totalDeposited;

      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: account.status, totalDeposited: account.totalDeposited },
        {
          $set: {
            status: 'terminated',
            closedAt: new Date(),
            closedById: new Types.ObjectId(actor.sub),
            commissionAmount: 0,
            payoutAmount: refund,
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      if (refund > 0) {
        await SusuPayoutModel.create(
          [
            {
              accountId: account._id,
              customerId: account.customerId,
              amount: refund,
              destination: 'cash',
              recordedById: new Types.ObjectId(actor.sub),
              idempotencyKey: `terminate:${account._id.toHexString()}`,
            },
          ],
          { session },
        );
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.account.terminate',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: account.totalDeposited,
          amountAfter: refund,
          after: { refund, depositsCount: account.depositsCount },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await SusuAccountModel.findById(accountId);
  if (!after) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (customer && refund > 0) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-termination',
      message:
        `Yadah: susu acct ${pre.accountNumber} has been terminated. ` +
        `Full refund of ${formatGhs(refund)} (no commission). Please collect at the office.`,
      relatedEntityType: 'susu-account',
      relatedEntityId: accountId,
    });
  }
  emitAdminEvent('susu.account.terminated', {
    id: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    refund,
  });

  return { account: toPublicAccount(after), refund };
}

// ---------------------------------------------------------------- pending payout

export interface PayoutResult {
  account: PublicSusuAccount;
  amount: number;
  replayed: boolean;
}

/**
 * Cash disbursement of a pending-payout account (office). The account
 * closes once its remaining value reaches zero.
 */
export async function payoutPending(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number | undefined,
  idempotencyKey: string,
  requestId?: string,
): Promise<PayoutResult> {
  const existing = await SusuPayoutModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SusuAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { account: toPublicAccount(account), amount: existing.amount, replayed: true };
  }

  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status !== 'pending-payout') {
    throw new AppError(
      'NOT_PENDING_PAYOUT',
      `Account is ${pre.status} — nothing awaiting payout`,
      422,
    );
  }
  const payAmount = amount ?? pre.payoutRemaining;
  if (payAmount > pre.payoutRemaining) {
    throw new AppError(
      'EXCEEDS_PAYOUT',
      `Only ${formatGhs(pre.payoutRemaining)} is awaiting payout`,
      422,
      {
        payoutRemaining: pre.payoutRemaining,
      },
    );
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const closesOut = payAmount === pre.payoutRemaining;
      const upd = await SusuAccountModel.updateOne(
        { _id: accountId, status: 'pending-payout', payoutRemaining: pre.payoutRemaining },
        {
          $inc: { payoutRemaining: -payAmount },
          ...(closesOut
            ? {
                $set: {
                  status: 'closed',
                  closedAt: new Date(),
                  closedById: new Types.ObjectId(actor.sub),
                },
              }
            : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      await SusuPayoutModel.create(
        [
          {
            accountId,
            customerId: pre.customerId,
            amount: payAmount,
            destination: 'cash',
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
          },
        ],
        { session },
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.payout',
          entityType: 'susu-account',
          entityId: accountId,
          amountBefore: pre.payoutRemaining,
          amountAfter: pre.payoutRemaining - payAmount,
          after: { destination: 'cash' },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await SusuAccountModel.findById(accountId);
  if (!after) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-payout',
      message:
        `Yadah: ${formatGhs(payAmount)} paid out from susu acct ${after.accountNumber}. ` +
        (after.payoutRemaining > 0
          ? `Still awaiting withdrawal: ${formatGhs(after.payoutRemaining)}.`
          : 'The account is now closed. Thank you!'),
      relatedEntityType: 'susu-account',
      relatedEntityId: accountId,
    });
  }
  emitAdminEvent('susu.payout', {
    id: accountId.toHexString(),
    accountNumber: after.accountNumber,
    amount: payAmount,
    payoutRemaining: after.payoutRemaining,
  });
  return { account: toPublicAccount(after), amount: payAmount, replayed: false };
}

// ---------------------------------------------------------------- trash

export interface PublicTrashedSusuAccount extends PublicSusuAccount {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toPublicTrashedAccount(a: SusuAccount): PublicTrashedSusuAccount {
  return {
    ...toPublicAccount(a),
    // Only ever called on docs in the trash, where deletedAt is set.
    deletedAt: requireDeletedAt(a.deletedAt),
    ...(a.deletedById ? { deletedById: a.deletedById.toHexString() } : {}),
    ...(a.deleteReason !== undefined ? { deleteReason: a.deleteReason } : {}),
  };
}

/**
 * Moves an account to the trash. Only empty, unused accounts qualify — an
 * account that ever held money must go through close/terminate so the ledger
 * keeps its history. Single-doc write, no transaction.
 */
export async function trashSusuAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<PublicTrashedSusuAccount> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);

  // Includes trashed deposits — any deposit ever recorded blocks the trash.
  const depositRecords = await SusuDepositModel.countDocuments({ accountId });
  if (
    account.status !== 'active' ||
    account.depositsCount !== 0 ||
    account.totalDeposited !== 0 ||
    account.payoutRemaining !== 0 ||
    depositRecords !== 0
  ) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only empty, unused susu accounts can be moved to the trash',
      422,
      {
        status: account.status,
        depositsCount: account.depositsCount,
        totalDeposited: account.totalDeposited,
        payoutRemaining: account.payoutRemaining,
        depositRecords,
      },
    );
  }
  const customer = await CustomerModel.findById(account.customerId);

  const now = new Date();
  const upd = await SusuAccountModel.updateOne(
    {
      _id: accountId,
      ...NOT_TRASHED,
      status: 'active',
      depositsCount: 0,
      totalDeposited: 0,
      payoutRemaining: 0,
    },
    {
      $set: {
        deletedAt: now,
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
  }

  await audit({
    actorId: actor.sub,
    action: 'susu.account.trash',
    entityType: 'susu-account',
    entityId: account._id,
    before: { status: account.status, deletedAt: null },
    after: {
      status: account.status,
      deletedAt: now.toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.account.trashed', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: account.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
  });

  account.deletedAt = now;
  account.deletedById = new Types.ObjectId(actor.sub);
  if (reason !== undefined) account.deleteReason = reason;
  return toPublicTrashedAccount(account);
}

/** Restores a trashed account. Unconditional — trashing has no side effects to reverse. */
export async function restoreSusuAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<PublicSusuAccount> {
  const account = await SusuAccountModel.findById(accountId);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (!account.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Susu account is not in the trash', 409);
  }
  const owner = await CustomerModel.findOne({ _id: account.customerId, ...NOT_TRASHED });
  if (!owner) {
    throw new AppError(
      'CANNOT_RESTORE',
      'The customer is in the trash — restore the customer first',
      422,
    );
  }
  const deletedAt = account.deletedAt;

  await SusuAccountModel.updateOne(
    { _id: accountId },
    { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
  );

  await audit({
    actorId: actor.sub,
    action: 'susu.account.restore',
    entityType: 'susu-account',
    entityId: account._id,
    before: { status: account.status, deletedAt: deletedAt.toISOString() },
    after: { status: account.status, deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.account.restored', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: account.customerId.toHexString(),
  });

  account.deletedAt = null;
  return toPublicAccount(account);
}

export async function listSusuAccountTrash(
  _actor: AccessTokenPayload,
  query: ListTrashQuery,
): Promise<{ items: PublicTrashedSusuAccount[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [accounts, total] = await Promise.all([
    SusuAccountModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuAccountModel.countDocuments(filter),
  ]);

  const names = await customerNamesById(accounts.map((a) => a.customerId));
  const items = accounts.map((a) => ({
    ...toPublicTrashedAccount(a),
    customerName: names.get(a.customerId.toHexString()) ?? '',
  }));
  return { items, page: query.page, limit: query.limit, total };
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

  const filter: Record<string, unknown> = { createdAt: { $gte: from, $lt: to }, ...NOT_TRASHED };
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

// ---------------------------------------------------------------- deposit corrections

export interface TrashedDeposit extends PublicDeposit {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedDeposit(d: SusuDeposit): TrashedDeposit {
  return {
    ...toPublicDeposit(d),
    deletedAt: requireDeletedAt(d.deletedAt),
    ...(d.deletedById ? { deletedById: d.deletedById.toHexString() } : {}),
    ...(d.deleteReason !== undefined ? { deleteReason: d.deleteReason } : {}),
  };
}

/**
 * Corrections only touch the most recent deposit of an open account — the
 * cycle is a contiguous 1..31 sequence, so removing or resizing anything
 * older would renumber every later deposit. Transfer-created deposits are
 * off-limits (the transfer leg would be orphaned).
 */
function assertCorrectable(account: SusuAccount, deposit: SusuDeposit): void {
  if (account.status !== 'active' && account.status !== 'completed') {
    throw new AppError(
      'CANNOT_TRASH',
      `Account is ${account.status} — closed accounts keep their history`,
      422,
    );
  }
  if (deposit.channel === 'transfer') {
    throw new AppError(
      'CANNOT_TRASH',
      'Deposits created by a transfer cannot be changed on their own',
      422,
    );
  }
  if (deposit.seqEnd !== account.depositsCount) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only the most recent deposit can be changed — correct from the end of the cycle',
      422,
      { seqEnd: deposit.seqEnd, depositsCount: account.depositsCount },
    );
  }
}

export async function trashDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<{ deposit: TrashedDeposit; account: PublicSusuAccount }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  assertCorrectable(account, deposit);

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await SusuAccountModel.updateOne(
        {
          _id: accountId,
          status: account.status,
          depositsCount: account.depositsCount,
          ...NOT_TRASHED,
        },
        {
          $inc: { depositsCount: -deposit.daysCovered, totalDeposited: -deposit.amount },
          // Un-completing: removing the last deposit reopens the cycle.
          ...(account.status === 'completed' ? { $set: { status: 'active' } } : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const depositUpd = await SusuDepositModel.updateOne(
        { _id: depositId, deletedAt: null },
        {
          $set: {
            deletedAt: now,
            deletedById: new Types.ObjectId(actor.sub),
            ...(reason !== undefined ? { deleteReason: reason } : {}),
          },
        },
        { session },
      );
      if (depositUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Deposit changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.trash',
          entityType: 'susu-deposit',
          entityId: depositId,
          amountBefore: account.totalDeposited,
          amountAfter: account.totalDeposited - deposit.amount,
          before: { amount: deposit.amount, daysCovered: deposit.daysCovered, deletedAt: null },
          after: {
            amount: deposit.amount,
            daysCovered: deposit.daysCovered,
            deletedAt: now,
            ...(reason !== undefined ? { reason } : {}),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const [afterDeposit, afterAccount] = await Promise.all([
    SusuDepositModel.findById(depositId),
    SusuAccountModel.findById(accountId),
  ]);
  if (!afterDeposit || !afterAccount) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  emitAdminEvent('susu.deposit.trashed', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amount: deposit.amount,
    depositsCount: afterAccount.depositsCount,
  });
  return { deposit: toTrashedDeposit(afterDeposit), account: toPublicAccount(afterAccount) };
}

export async function restoreDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  requestId?: string,
): Promise<{ deposit: PublicDeposit; account: PublicSusuAccount }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  if (!deposit.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Deposit is not in the trash', 409);
  }
  if (account.status !== 'active') {
    throw new AppError('CANNOT_RESTORE', `Account is ${account.status} — cannot restore`, 422);
  }
  if (account.depositsCount !== deposit.seqStart - 1) {
    throw new AppError('CANNOT_RESTORE', 'The deposit’s cycle positions are no longer free', 422, {
      seqStart: deposit.seqStart,
      depositsCount: account.depositsCount,
    });
  }

  const completes = deposit.seqEnd === SUSU_CYCLE_DEPOSITS;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await SusuAccountModel.updateOne(
        {
          _id: accountId,
          status: 'active',
          depositsCount: account.depositsCount,
          ...NOT_TRASHED,
        },
        {
          $inc: { depositsCount: deposit.daysCovered, totalDeposited: deposit.amount },
          ...(completes ? { $set: { status: 'completed' } } : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const depositUpd = await SusuDepositModel.updateOne(
        { _id: depositId, deletedAt: { $ne: null } },
        { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
        { session },
      );
      if (depositUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Deposit changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.restore',
          entityType: 'susu-deposit',
          entityId: depositId,
          amountBefore: account.totalDeposited,
          amountAfter: account.totalDeposited + deposit.amount,
          before: { amount: deposit.amount, deletedAt: deposit.deletedAt },
          after: { amount: deposit.amount, deletedAt: null },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const [afterDeposit, afterAccount] = await Promise.all([
    SusuDepositModel.findById(depositId),
    SusuAccountModel.findById(accountId),
  ]);
  if (!afterDeposit || !afterAccount) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  emitAdminEvent('susu.deposit.restored', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amount: deposit.amount,
    depositsCount: afterAccount.depositsCount,
  });
  return { deposit: toPublicDeposit(afterDeposit), account: toPublicAccount(afterAccount) };
}

export async function listDepositTrash(
  _actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListTrashQuery,
): Promise<{ items: TrashedDeposit[]; page: number; limit: number; total: number }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const filter = { accountId, deletedAt: { $ne: null } };
  const [deposits, total] = await Promise.all([
    SusuDepositModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuDepositModel.countDocuments(filter),
  ]);
  return { items: deposits.map(toTrashedDeposit), page: query.page, limit: query.limit, total };
}

/** Correct the amount of the most recent deposit (data-entry fixes). */
export async function updateDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  amount: number,
  requestId?: string,
): Promise<DepositResult> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  assertCorrectable(account, deposit);

  if (amount % account.dailyAmount !== 0) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `Susu deposits must be a multiple of the daily amount (${formatGhs(account.dailyAmount)})`,
      422,
      { dailyAmount: account.dailyAmount },
    );
  }
  const newDays = amount / account.dailyAmount;
  const dayDelta = newDays - deposit.daysCovered;
  const remaining = remainingDeposits(account.depositsCount);
  if (dayDelta > remaining) {
    throw new AppError(
      'EXCEEDS_REMAINING',
      `Only ${String(remaining)} deposit day(s) remain in this cycle`,
      422,
      { remaining },
    );
  }
  if (dayDelta === 0 && amount === deposit.amount) {
    return {
      deposit: toPublicDeposit(deposit),
      account: toPublicAccount(account),
      replayed: false,
    };
  }

  const newCount = account.depositsCount + dayDelta;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await SusuAccountModel.updateOne(
        {
          _id: accountId,
          status: account.status,
          depositsCount: account.depositsCount,
          ...NOT_TRASHED,
        },
        {
          $inc: { depositsCount: dayDelta, totalDeposited: amount - deposit.amount },
          ...(newCount === SUSU_CYCLE_DEPOSITS && account.status === 'active'
            ? { $set: { status: 'completed' } }
            : {}),
          ...(newCount < SUSU_CYCLE_DEPOSITS && account.status === 'completed'
            ? { $set: { status: 'active' } }
            : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const depositUpd = await SusuDepositModel.updateOne(
        { _id: depositId, ...NOT_TRASHED, amount: deposit.amount },
        {
          $set: {
            amount,
            daysCovered: newDays,
            seqEnd: deposit.seqStart + newDays - 1,
          },
        },
        { session },
      );
      if (depositUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Deposit changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.update',
          entityType: 'susu-deposit',
          entityId: depositId,
          amountBefore: deposit.amount,
          amountAfter: amount,
          before: { amount: deposit.amount, daysCovered: deposit.daysCovered },
          after: { amount, daysCovered: newDays },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const [afterDeposit, afterAccount] = await Promise.all([
    SusuDepositModel.findById(depositId),
    SusuAccountModel.findById(accountId),
  ]);
  if (!afterDeposit || !afterAccount) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  emitAdminEvent('susu.deposit.updated', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amountBefore: deposit.amount,
    amountAfter: amount,
    depositsCount: afterAccount.depositsCount,
  });
  return {
    deposit: toPublicDeposit(afterDeposit),
    account: toPublicAccount(afterAccount),
    replayed: false,
  };
}
