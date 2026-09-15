import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { nextAccountNumber } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { resolveOccurredAt } from '../../lib/backdating.js';
import type { CorrectionPlan, CorrectionPreparer } from '../../lib/corrections.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import { assertCanActOnCustomer, withCustomerScope } from '../../lib/customer-scope.js';
import {
  CustomerModel,
  SavingsAccountModel,
  SavingsTxnModel,
  UserModel,
  type Customer,
  type SavingsAccount,
  type SavingsAccountType,
  type SavingsTxn,
} from '../../models/index.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import {
  MIN_DEPOSIT,
  availableToWithdraw,
  computeSavingsClosure,
  computeWithdrawal,
} from '../../domain/savings.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { NOT_TRASHED, requireDeletedAt, type Channel } from '../../models/shared.js';
import type { ListAccountsQuery, ListTrashQuery, ListTxnsQuery } from './savings.schemas.js';

// ---------------------------------------------------------------- shapes

export interface PublicSavingsAccount {
  id: string;
  accountNumber: string;
  customerId: string;
  /** Present on list responses for display; joined from the customer. */
  customerName?: string;
  /** Label only — student accounts follow identical money rules. */
  accountType: SavingsAccountType;
  balance: number;
  /** balance − 50 − 10, never negative (rule 4 — always exposed). */
  availableToWithdraw: number;
  status: 'active' | 'closed';
  openedAt: Date;
  closedAt?: Date;
}

export function toPublicSavingsAccount(a: SavingsAccount): PublicSavingsAccount {
  return {
    id: a._id.toHexString(),
    accountNumber: a.accountNumber,
    customerId: a.customerId.toHexString(),
    accountType: a.accountType,
    balance: a.balance,
    availableToWithdraw: a.status === 'active' ? availableToWithdraw(a.balance) : 0,
    status: a.status,
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
  };
}

/** Flat spreadsheet row for account listing exports (csv/xlsx). */
export function toSavingsAccountExportRow(a: PublicSavingsAccount): Record<string, unknown> {
  return {
    id: a.id,
    accountNumber: a.accountNumber,
    customerName: a.customerName ?? '',
    customerId: a.customerId,
    accountType: a.accountType,
    balance: a.balance,
    availableToWithdraw: a.availableToWithdraw,
    status: a.status,
    openedAt: a.openedAt,
    closedAt: a.closedAt ?? null,
  };
}

export interface PublicSavingsTxn {
  id: string;
  accountId: string;
  customerId: string;
  type: 'deposit' | 'withdrawal' | 'closure';
  amount: number;
  fee?: number;
  balanceAfter: number;
  channel: string;
  accraDay: string;
  recordedById: string;
  createdAt: Date;
}

export function toPublicTxn(t: SavingsTxn): PublicSavingsTxn {
  return {
    id: t._id.toHexString(),
    accountId: t.accountId.toHexString(),
    customerId: t.customerId.toHexString(),
    type: t.type,
    amount: t.amount,
    ...(t.fee !== undefined ? { fee: t.fee } : {}),
    balanceAfter: t.balanceAfter,
    channel: t.channel,
    accraDay: t.accraDay,
    recordedById: t.recordedById.toHexString(),
    createdAt: t.createdAt,
  };
}

/** Flat spreadsheet row for transaction statement exports (csv/xlsx). */
export function toSavingsTxnExportRow(t: PublicSavingsTxn): Record<string, unknown> {
  return {
    id: t.id,
    type: t.type,
    amount: t.amount,
    fee: t.fee ?? null,
    balanceAfter: t.balanceAfter,
    channel: t.channel,
    accraDay: t.accraDay,
    recordedById: t.recordedById,
    createdAt: t.createdAt,
  };
}

// ---------------------------------------------------------------- helpers

async function loadCustomer(customerId: Types.ObjectId): Promise<Customer> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return customer;
}

/**
 * What the account held at an instant, read off the statement rather than the
 * account.
 *
 * `SavingsAccount.balance` is only ever the balance NOW. A transaction typed
 * in for last Tuesday belongs between the rows either side of it, and what it
 * leaves behind is last Tuesday's balance plus its own effect — so the figure
 * it is built from has to be found where it sits, not at the end.
 */
async function balanceAsOf(
  session: mongoose.ClientSession,
  accountId: Types.ObjectId,
  at: Date,
): Promise<number> {
  const last = await SavingsTxnModel.findOne(
    { accountId, createdAt: { $lte: at }, ...NOT_TRASHED },
    { balanceAfter: 1 },
  )
    .sort({ createdAt: -1, _id: -1 })
    .session(session);
  return last?.balanceAfter ?? 0;
}

/**
 * Moves the running balance of everything recorded after an instant.
 *
 * Every savings row carries the balance the account stood at once it landed,
 * and the statement is read down that column. Insert a row into the middle of
 * that history and every figure below it is out by the amount inserted, so
 * they are all moved together, inside the same transaction that writes the
 * row. Appending to the end — the ordinary case — finds nothing to move.
 *
 * Money going out is checked before it is applied: history that has already
 * happened cannot be made to show an overdrawn account by something typed in
 * underneath it.
 */
async function shiftBalancesAfter(
  session: mongoose.ClientSession,
  accountId: Types.ObjectId,
  at: Date,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const later = { accountId, createdAt: { $gt: at }, ...NOT_TRASHED };
  if (delta < 0) {
    const lowest = await SavingsTxnModel.findOne(later, { balanceAfter: 1 })
      .sort({ balanceAfter: 1 })
      .session(session);
    if (lowest && lowest.balanceAfter + delta < 0) {
      throw new AppError(
        'BACKDATE_OVERDRAWS',
        'Taking that out on that day would leave the account overdrawn later in its history',
        422,
        {
          lowestBalanceAfter: lowest.balanceAfter,
          shortfall: -(lowest.balanceAfter + delta),
        },
      );
    }
  }
  await SavingsTxnModel.updateMany(later, { $inc: { balanceAfter: delta } }, { session });
}

function mapDuplicateKey(err: unknown): never {
  if (err instanceof MongoServerError && err.code === 11000) {
    const keys = Object.keys((err.keyPattern as Record<string, unknown> | undefined) ?? {});
    if (keys.includes('accraDay')) {
      throw new AppError(
        'WITHDRAWAL_LIMIT',
        'Only one withdrawal (or closure) is allowed per day on an account',
        409,
      );
    }
  }
  throw err as Error;
}

// ---------------------------------------------------------------- accounts

export async function openAccount(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  initialDeposit: number | undefined,
  idempotencyKey: string | undefined,
  channel: Channel,
  accountType: SavingsAccountType = 'standard',
  requestId?: string,
): Promise<{ account: PublicSavingsAccount; initialTxn?: PublicSavingsTxn }> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }

  // Reserved before the session opens: the counter must not join the money
  // transaction (see lib/account-number.ts). A rolled-back opening leaves a
  // gap in the sequence, which is harmless.
  let accountNumber = await nextAccountNumber('SV');

  const session = await mongoose.startSession();
  let account!: SavingsAccount;
  let initialTxn: SavingsTxn | undefined;
  try {
    await session.withTransaction(async () => {
      let created;
      for (let attempt = 0; ; attempt++) {
        try {
          [created] = await SavingsAccountModel.create(
            [
              {
                accountNumber,
                customerId,
                accountType,
                balance: initialDeposit ?? 0,
                openedById: new Types.ObjectId(actor.sub),
              },
            ],
            { session },
          );
          break;
        } catch (err) {
          // Sequential numbers shouldn't collide, but a concurrent migration or
          // a stale counter could — take the next one rather than fail the open.
          if (err instanceof MongoServerError && err.code === 11000 && attempt < 5) {
            accountNumber = await nextAccountNumber('SV');
            continue;
          }
          throw err;
        }
      }
      account = created as SavingsAccount;

      await audit(
        {
          actorId: actor.sub,
          action: 'savings.account.open',
          entityType: 'savings-account',
          entityId: account._id,
          amountAfter: initialDeposit ?? 0,
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );

      if (initialDeposit !== undefined) {
        const [txn] = await SavingsTxnModel.create(
          [
            {
              accountId: account._id,
              customerId,
              type: 'deposit',
              amount: initialDeposit,
              balanceAfter: initialDeposit,
              channel,
              accraDay: accraDay(),
              recordedById: new Types.ObjectId(actor.sub),
              ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
            },
          ],
          { session },
        );
        initialTxn = txn;
      }
    });
  } finally {
    await session.endSession();
  }

  emitAdminEvent('savings.account.opened', {
    id: account._id.toHexString(),
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    balance: account.balance,
  });
  return {
    account: toPublicSavingsAccount(account),
    ...(initialTxn ? { initialTxn: toPublicTxn(initialTxn) } : {}),
  };
}

export async function listAccounts(
  actor: AccessTokenPayload,
  query: ListAccountsQuery,
): Promise<{ items: PublicSavingsAccount[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.accountType) filter.accountType = query.accountType;
  if (query.status) filter.status = query.status;
  if (query.accountNumber !== undefined) filter.accountNumber = query.accountNumber;
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;

  // Fuzzy: match by customer (typo-tolerant name/phone) or account number prefix.
  if (query.search !== undefined) {
    const customerIds = await fuzzyCustomerIds(query.search);
    const or: Record<string, unknown>[] = [{ customerId: { $in: customerIds } }];
    if (/^\d{2,10}$/.test(query.search)) {
      or.push({ accountNumber: { $regex: `^${query.search}` } });
    }
    filter.$or = or;
  }

  // Top-level customerId condition — ANDed with the search $or by Mongo, so an
  // account-number search cannot reach outside the collector's round.
  const scoped = await withCustomerScope(actor, filter);

  const [accounts, total] = await Promise.all([
    SavingsAccountModel.find(scoped)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsAccountModel.countDocuments(scoped),
  ]);

  const unique = [...new Set(accounts.map((a) => a.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: accounts.map((a) => ({
      ...toPublicSavingsAccount(a),
      customerName: names.get(a.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getAccount(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSavingsAccount> {
  const account = await SavingsAccountModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);
  return toPublicSavingsAccount(account);
}

export async function listTransactions(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListTxnsQuery,
): Promise<{ items: PublicSavingsTxn[]; page: number; limit: number; total: number }> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);

  const txnFilter: Record<string, unknown> = { accountId, ...NOT_TRASHED };
  const txnDateFilter = createdAtFilter(query.from, query.to);
  if (txnDateFilter) txnFilter.createdAt = txnDateFilter;
  const [txns, total] = await Promise.all([
    SavingsTxnModel.find(txnFilter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsTxnModel.countDocuments(txnFilter),
  ]);
  return { items: txns.map(toPublicTxn), page: query.page, limit: query.limit, total };
}

// ---------------------------------------------------------------- deposit

export interface TxnResult {
  txn: PublicSavingsTxn;
  account: PublicSavingsAccount;
  replayed: boolean;
}

export async function deposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
  occurredOn?: string,
): Promise<TxnResult> {
  // The day the money changed hands. Resolved before anything is read, so a
  // date the server will not accept costs nothing.
  const at = resolveOccurredAt(actor, occurredOn);
  const existing = await SavingsTxnModel.findOne({ idempotencyKey });
  if (existing) {
    if (existing.deletedAt) {
      throw new AppError(
        'CONFLICT',
        'The original transaction was moved to the trash — use a new idempotency key',
        409,
      );
    }
    const account = await SavingsAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { txn: toPublicTxn(existing), account: toPublicSavingsAccount(account), replayed: true };
  }

  const pre = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, pre.customerId);
  await loadCustomer(pre.customerId);

  const backdated = occurredOn !== undefined;
  const session = await mongoose.startSession();
  let txn!: SavingsTxn;
  try {
    await session.withTransaction(async () => {
      const account = await SavingsAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);

      const upd = await SavingsAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
        { $inc: { balance: amount } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      // Where this row sits in the statement. Dated now — every ordinary
      // deposit — that is the end of it and the account's own balance is the
      // answer; dated back, it is whatever the account held that day.
      const opening = backdated ? await balanceAsOf(session, account._id, at) : account.balance;
      // Only a dated-back row has anything below it to move. Skipped outright
      // otherwise, so the path every ordinary deposit takes is the one it
      // always took.
      if (backdated) await shiftBalancesAfter(session, account._id, at, amount);

      const [created] = await SavingsTxnModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            type: 'deposit',
            amount,
            balanceAfter: opening + amount,
            channel,
            accraDay: accraDay(at),
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
            // `createdAt` is the day the money moved and is what the ledger,
            // the dashboard and the statement read; `updatedAt` is when the
            // row was written. The two differ only on a backdated entry.
            createdAt: at,
            updatedAt: new Date(),
          },
        ],
        { session, timestamps: false },
      );
      txn = created as SavingsTxn;

      await audit(
        {
          actorId: actor.sub,
          action: 'savings.deposit.record',
          entityType: 'savings-account',
          entityId: account._id,
          amountBefore: account.balance,
          amountAfter: account.balance + amount,
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await SavingsAccountModel.findById(accountId);
  if (!after) throw new AppError('NOT_FOUND', 'Account not found', 404);

  emitAdminEvent('savings.txn', {
    accountId: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    type: 'deposit',
    amount,
    balance: after.balance,
  });
  return { txn: toPublicTxn(txn), account: toPublicSavingsAccount(after), replayed: false };
}

// ---------------------------------------------------------------- withdrawal

export async function withdraw(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  requestId?: string,
  occurredOn?: string,
): Promise<TxnResult> {
  // The day the customer was handed the cash.
  const at = resolveOccurredAt(actor, occurredOn);
  const backdated = occurredOn !== undefined;
  const existing = await SavingsTxnModel.findOne({ idempotencyKey });
  if (existing) {
    if (existing.deletedAt) {
      throw new AppError(
        'CONFLICT',
        'The original transaction was moved to the trash — use a new idempotency key',
        409,
      );
    }
    const account = await SavingsAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { txn: toPublicTxn(existing), account: toPublicSavingsAccount(account), replayed: true };
  }

  const pre = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let txn!: SavingsTxn;
  try {
    await session.withTransaction(async () => {
      const account = await SavingsAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);

      // One withdrawal per account per day, on the day it is dated — which on
      // a backdated entry is not today. The unique index enforces the same
      // rule underneath, so a race arrives as a duplicate key rather than a
      // second withdrawal.
      const day = accraDay(at);
      const dayCashOut = await SavingsTxnModel.findOne({
        accountId: account._id,
        accraDay: day,
        countsTowardDailyLimit: true,
      }).session(session);
      if (dayCashOut) {
        throw new AppError(
          'WITHDRAWAL_LIMIT',
          'Only one withdrawal is allowed per day on an account',
          409,
        );
      }

      // What the account could give up THAT day: the minimum balance and the
      // fee are the rules that applied then, so they are applied to the
      // balance as it stood then rather than to today's.
      const opening = backdated ? await balanceAsOf(session, account._id, at) : account.balance;
      let computation;
      try {
        computation = computeWithdrawal(opening, amount);
      } catch (err) {
        if (err instanceof RangeError) {
          throw new AppError('EXCEEDS_AVAILABLE', 'Amount exceeds the available balance', 422, {
            available: availableToWithdraw(opening),
          });
        }
        throw err;
      }

      const upd = await SavingsAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
        { $inc: { balance: -computation.totalDebit } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      // Everything recorded after it drops by what left the account. Nothing
      // is below an ordinary withdrawal, so it is skipped there.
      if (backdated) {
        await shiftBalancesAfter(session, account._id, at, -computation.totalDebit);
      }

      const [created] = await SavingsTxnModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            type: 'withdrawal',
            amount,
            fee: computation.fee,
            balanceAfter: computation.balanceAfter,
            channel: 'cash',
            accraDay: day,
            countsTowardDailyLimit: true,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
            createdAt: at,
            updatedAt: new Date(),
          },
        ],
        { session, timestamps: false },
      );
      txn = created as SavingsTxn;

      await audit(
        {
          actorId: actor.sub,
          action: 'savings.withdrawal.record',
          entityType: 'savings-account',
          entityId: account._id,
          amountBefore: account.balance,
          amountAfter: computation.balanceAfter,
          after: { amount, fee: computation.fee },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } catch (err) {
    mapDuplicateKey(err);
  } finally {
    await session.endSession();
  }

  const after = await SavingsAccountModel.findById(accountId);
  if (!after) throw new AppError('NOT_FOUND', 'Account not found', 404);

  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'savings-withdrawal',
      message:
        `Yadah: withdrawal of ${formatGhs(txn.amount)} processed on acct ${after.accountNumber} ` +
        `(fee ${formatGhs(txn.fee ?? 0)}). New balance: ${formatGhs(after.balance)}.`,
      relatedEntityType: 'savings-txn',
      relatedEntityId: txn._id,
    });
  }
  emitAdminEvent('savings.txn', {
    accountId: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    type: 'withdrawal',
    amount,
    balance: after.balance,
  });
  return { txn: toPublicTxn(txn), account: toPublicSavingsAccount(after), replayed: false };
}

// ---------------------------------------------------------------- closure

export interface SavingsClosureResult {
  account: PublicSavingsAccount;
  fee: number;
  payout: number;
  flagged: boolean;
}

export async function closeAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<SavingsClosureResult> {
  const pre = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status === 'closed')
    throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let result!: SavingsClosureResult;
  try {
    await session.withTransaction(async () => {
      const account = await SavingsAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);

      const today = accraDay();
      const todayCashOut = await SavingsTxnModel.findOne({
        accountId: account._id,
        accraDay: today,
        countsTowardDailyLimit: true,
      }).session(session);
      if (todayCashOut) {
        throw new AppError(
          'WITHDRAWAL_LIMIT',
          'Only one withdrawal (or closure) is allowed per day on an account',
          409,
        );
      }

      const { fee, payout, flagged } = computeSavingsClosure(account.balance);
      const now = new Date();
      const upd = await SavingsAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
        {
          $set: {
            status: 'closed',
            balance: 0,
            closedAt: now,
            closedById: new Types.ObjectId(actor.sub),
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      await SavingsTxnModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            type: 'closure',
            amount: payout,
            fee,
            balanceAfter: 0,
            channel: 'cash',
            accraDay: today,
            countsTowardDailyLimit: true,
            recordedById: new Types.ObjectId(actor.sub),
          },
        ],
        { session },
      );

      await audit(
        {
          actorId: actor.sub,
          action: 'savings.account.close',
          entityType: 'savings-account',
          entityId: account._id,
          amountBefore: account.balance,
          amountAfter: payout,
          after: { fee, payout, flagged },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );

      account.status = 'closed';
      account.balance = 0;
      account.closedAt = now;
      result = { account: toPublicSavingsAccount(account), fee, payout, flagged };
    });
  } catch (err) {
    mapDuplicateKey(err);
  } finally {
    await session.endSession();
  }

  if (customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'savings-closure',
      message:
        `Yadah: savings acct ${pre.accountNumber} has been closed. Payout: ${formatGhs(result.payout)} ` +
        `(fee ${formatGhs(result.fee)}). Please collect at the office.`,
      relatedEntityType: 'savings-account',
      relatedEntityId: accountId,
    });
  }
  emitAdminEvent('savings.account.closed', {
    id: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    payout: result.payout,
    fee: result.fee,
    flagged: result.flagged,
  });
  return result;
}

// ---------------------------------------------------------------- trash

export interface TrashedSavingsAccount extends PublicSavingsAccount {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

/** Only called on docs known to be trashed, so deletedAt is set. */
function toTrashedSavingsAccount(a: SavingsAccount): TrashedSavingsAccount {
  return {
    ...toPublicSavingsAccount(a),
    deletedAt: requireDeletedAt(a.deletedAt),
    ...(a.deletedById !== undefined ? { deletedById: a.deletedById.toHexString() } : {}),
    ...(a.deleteReason !== undefined ? { deleteReason: a.deleteReason } : {}),
  };
}

export async function trashSavingsAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<{ account: TrashedSavingsAccount }> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);

  // Trashed transactions count too — any history at all blocks the trash.
  const txnCount = await SavingsTxnModel.countDocuments({ accountId: account._id });
  if (account.status !== 'active' || account.balance !== 0 || txnCount !== 0) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only empty, unused savings accounts can be moved to the trash',
      422,
      { status: account.status, balance: account.balance, txnCount },
    );
  }

  const now = new Date();
  await SavingsAccountModel.updateOne(
    { _id: account._id },
    {
      $set: {
        deletedAt: now,
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
  );
  account.deletedAt = now;
  account.deletedById = new Types.ObjectId(actor.sub);
  if (reason !== undefined) account.deleteReason = reason;

  await audit({
    actorId: actor.sub,
    action: 'savings.account.trash',
    entityType: 'savings-account',
    entityId: account._id,
    before: { status: account.status, deletedAt: null },
    after: {
      status: account.status,
      deletedAt: now,
      ...(reason !== undefined ? { reason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  emitAdminEvent('savings.account.trashed', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: account.customerId.toHexString(),
  });
  return { account: toTrashedSavingsAccount(account) };
}

export async function restoreSavingsAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<{ account: PublicSavingsAccount }> {
  const account = await SavingsAccountModel.findById(accountId);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (!account.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Savings account is not in the trash', 409);
  }
  const owner = await CustomerModel.findOne({ _id: account.customerId, ...NOT_TRASHED });
  if (!owner) {
    throw new AppError(
      'CANNOT_RESTORE',
      'The customer is in the trash — restore the customer first',
      422,
    );
  }

  await SavingsAccountModel.updateOne(
    { _id: account._id },
    { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
  );

  await audit({
    actorId: actor.sub,
    action: 'savings.account.restore',
    entityType: 'savings-account',
    entityId: account._id,
    before: { status: account.status, deletedAt: account.deletedAt },
    after: { status: account.status, deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });

  emitAdminEvent('savings.account.restored', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: account.customerId.toHexString(),
  });
  return { account: toPublicSavingsAccount(account) };
}

export async function listSavingsAccountTrash(
  _actor: AccessTokenPayload,
  query: ListTrashQuery,
): Promise<{ items: TrashedSavingsAccount[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [accounts, total] = await Promise.all([
    SavingsAccountModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsAccountModel.countDocuments(filter),
  ]);

  const unique = [...new Set(accounts.map((a) => a.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: accounts.map((a) => ({
      ...toTrashedSavingsAccount(a),
      customerName: names.get(a.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- txn trash

export interface TrashedSavingsTxn extends PublicSavingsTxn {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedTxn(t: SavingsTxn): TrashedSavingsTxn {
  return {
    ...toPublicTxn(t),
    deletedAt: requireDeletedAt(t.deletedAt),
    ...(t.deletedById !== undefined ? { deletedById: t.deletedById.toHexString() } : {}),
    ...(t.deleteReason !== undefined ? { deleteReason: t.deleteReason } : {}),
  };
}

/**
 * Moving a transaction to the trash reverses its balance effect, so only the
 * newest live transaction of an active account qualifies — older mistakes are
 * corrected by trashing forward from the end, keeping the balance history
 * consistent. Trashing a withdrawal also frees its 1-per-day slot.
 */
export async function trashSavingsTxn(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  txnId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<{ txn: TrashedSavingsTxn; account: PublicSavingsAccount }> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const txn = await SavingsTxnModel.findOne({ _id: txnId, accountId, ...NOT_TRASHED });
  if (!txn) throw new AppError('NOT_FOUND', 'Transaction not found', 404);

  if (txn.type === 'closure') {
    throw new AppError('CANNOT_TRASH', 'Closure transactions cannot be moved to the trash', 422);
  }
  if (txn.channel === 'transfer') {
    throw new AppError(
      'CANNOT_TRASH',
      'Transactions created by a transfer cannot be trashed on their own',
      422,
    );
  }
  if (account.status !== 'active') {
    throw new AppError('CANNOT_TRASH', 'Only transactions on active accounts can be trashed', 422);
  }
  const newest = await SavingsTxnModel.findOne({ accountId, ...NOT_TRASHED }).sort({
    createdAt: -1,
    _id: -1,
  });
  if (!newest?._id.equals(txn._id)) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only the most recent transaction can be moved to the trash',
      422,
    );
  }

  // deposit: take the money back out; withdrawal: put amount + fee back in.
  const delta = txn.type === 'deposit' ? -txn.amount : txn.amount + (txn.fee ?? 0);
  const now = new Date();

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await SavingsAccountModel.updateOne(
        { _id: accountId, status: 'active', balance: txn.balanceAfter, ...NOT_TRASHED },
        { $inc: { balance: delta } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const txnUpd = await SavingsTxnModel.updateOne(
        { _id: txnId, deletedAt: null },
        {
          $set: {
            deletedAt: now,
            deletedById: new Types.ObjectId(actor.sub),
            ...(reason !== undefined ? { deleteReason: reason } : {}),
          },
          $unset: { countsTowardDailyLimit: '' },
        },
        { session },
      );
      if (txnUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Transaction changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'savings.txn.trash',
          entityType: 'savings-txn',
          entityId: txnId,
          amountBefore: txn.balanceAfter,
          amountAfter: txn.balanceAfter + delta,
          before: { type: txn.type, amount: txn.amount, deletedAt: null },
          after: {
            type: txn.type,
            amount: txn.amount,
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

  const [afterTxn, afterAccount] = await Promise.all([
    SavingsTxnModel.findById(txnId),
    SavingsAccountModel.findById(accountId),
  ]);
  if (!afterTxn || !afterAccount) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  emitAdminEvent('savings.txn.trashed', {
    accountId: accountId.toHexString(),
    txnId: txnId.toHexString(),
    type: txn.type,
    amount: txn.amount,
    balance: afterAccount.balance,
  });
  return { txn: toTrashedTxn(afterTxn), account: toPublicSavingsAccount(afterAccount) };
}

export async function restoreSavingsTxn(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  txnId: Types.ObjectId,
  requestId?: string,
): Promise<{ txn: PublicSavingsTxn; account: PublicSavingsAccount }> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const txn = await SavingsTxnModel.findOne({ _id: txnId, accountId });
  if (!txn) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  if (!txn.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Transaction is not in the trash', 409);
  }
  if (account.status !== 'active') {
    throw new AppError('CANNOT_RESTORE', 'Only active accounts can take a restore', 422);
  }
  const newerLive = await SavingsTxnModel.findOne({
    accountId,
    ...NOT_TRASHED,
    createdAt: { $gt: txn.createdAt },
  });
  if (newerLive) {
    throw new AppError(
      'CANNOT_RESTORE',
      'Newer transactions exist on the account — the balance has moved on',
      422,
    );
  }

  // Reverse of trash: deposit puts the money back; withdrawal re-debits.
  const delta = txn.type === 'deposit' ? txn.amount : -(txn.amount + (txn.fee ?? 0));
  const expectedBalance = txn.balanceAfter - delta;

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await SavingsAccountModel.updateOne(
        { _id: accountId, status: 'active', balance: expectedBalance, ...NOT_TRASHED },
        { $inc: { balance: delta } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const txnUpd = await SavingsTxnModel.updateOne(
        { _id: txnId, deletedAt: { $ne: null } },
        {
          $set: {
            deletedAt: null,
            ...(txn.type === 'withdrawal' ? { countsTowardDailyLimit: true } : {}),
          },
          $unset: { deletedById: '', deleteReason: '' },
        },
        { session },
      );
      if (txnUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Transaction changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'savings.txn.restore',
          entityType: 'savings-txn',
          entityId: txnId,
          amountBefore: expectedBalance,
          amountAfter: txn.balanceAfter,
          before: { type: txn.type, amount: txn.amount, deletedAt: txn.deletedAt },
          after: { type: txn.type, amount: txn.amount, deletedAt: null },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } catch (err) {
    // Restoring a withdrawal re-claims its accraDay — taken meanwhile → 409.
    mapDuplicateKey(err);
  } finally {
    await session.endSession();
  }

  const [afterTxn, afterAccount] = await Promise.all([
    SavingsTxnModel.findById(txnId),
    SavingsAccountModel.findById(accountId),
  ]);
  if (!afterTxn || !afterAccount) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  emitAdminEvent('savings.txn.restored', {
    accountId: accountId.toHexString(),
    txnId: txnId.toHexString(),
    type: txn.type,
    amount: txn.amount,
    balance: afterAccount.balance,
  });
  return { txn: toPublicTxn(afterTxn), account: toPublicSavingsAccount(afterAccount) };
}

// ---------------------------------------------------------------- corrections

/**
 * Correcting the amount on a deposit or withdrawal, for the corrections module
 * (see lib/corrections.ts): outright for the office, or after a teller asked
 * and the office approved.
 *
 * Only the newest live transaction of an active account qualifies, for the
 * same reason only that one can be trashed: every later running balance is
 * built on it. A withdrawal keeps its flat fee and is checked against what
 * the account held before it, exactly as it was when first recorded; a
 * deposit keeps the floor every deposit has. Transfer legs, Paystack charges
 * and closures are not data entry and cannot be corrected here.
 */
export const prepareTxnCorrection: CorrectionPreparer = async (accountId, txnId) => {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const txn = await SavingsTxnModel.findOne({ _id: txnId, accountId, ...NOT_TRASHED });
  if (!txn) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  const newest = await SavingsTxnModel.findOne({ accountId, ...NOT_TRASHED }).sort({
    createdAt: -1,
    _id: -1,
  });
  const isNewest = newest?._id.equals(txn._id) ?? false;
  const fee = txn.fee ?? 0;
  // What the account held before this transaction — the figure a corrected
  // withdrawal is checked against, as the original was.
  const balanceBefore =
    txn.type === 'deposit' ? txn.balanceAfter - txn.amount : txn.balanceAfter + txn.amount + fee;

  const plan = (amount: number): CorrectionPlan => {
    if (txn.type === 'closure') {
      throw new AppError('CANNOT_CORRECT', 'A closure is final and cannot be changed', 422);
    }
    if (txn.channel === 'transfer') {
      throw new AppError(
        'CANNOT_CORRECT',
        'Transactions created by a transfer cannot be changed on their own',
        422,
      );
    }
    if (txn.channel === 'paystack') {
      throw new AppError(
        'CANNOT_CORRECT',
        'This was paid through Paystack, so the amount is what was charged',
        422,
      );
    }
    if (account.status !== 'active') {
      throw new AppError(
        'CANNOT_CORRECT',
        `Account is ${account.status} — closed accounts keep their history`,
        422,
      );
    }
    if (!isNewest) {
      throw new AppError(
        'CANNOT_CORRECT',
        'Only the most recent transaction can be changed — correct from the end of the statement',
        422,
      );
    }
    if (txn.type === 'deposit') {
      if (amount < MIN_DEPOSIT) {
        throw new AppError('AMOUNT_TOO_SMALL', `Deposits start at ${formatGhs(MIN_DEPOSIT)}`, 422, {
          minimum: MIN_DEPOSIT,
        });
      }
    } else {
      const available = availableToWithdraw(balanceBefore);
      if (amount > available) {
        throw new AppError('EXCEEDS_AVAILABLE', 'Amount exceeds the available balance', 422, {
          available,
        });
      }
    }
    return {};
  };

  return {
    kind: 'savings-txn',
    targetId: accountId,
    txnId,
    customerId: txn.customerId,
    amount: txn.amount,
    plan,
    apply: async (session, actor, amount, requestId, origin) => {
      plan(amount);
      const balanceAfter =
        txn.type === 'deposit' ? balanceBefore + amount : balanceBefore - amount - fee;
      const delta = balanceAfter - txn.balanceAfter;
      // The newest transaction's running balance IS the account's balance, so
      // guarding on it guards against anything having moved since.
      const upd = await SavingsAccountModel.updateOne(
        { _id: accountId, status: 'active', balance: txn.balanceAfter, ...NOT_TRASHED },
        { $inc: { balance: delta } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const txnUpd = await SavingsTxnModel.updateOne(
        { _id: txnId, deletedAt: null, amount: txn.amount },
        { $set: { amount, balanceAfter } },
        { session },
      );
      if (txnUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Transaction changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'savings.txn.update',
          entityType: 'savings-txn',
          entityId: txnId,
          amountBefore: txn.balanceAfter,
          amountAfter: balanceAfter,
          before: { type: txn.type, amount: txn.amount },
          after: {
            type: txn.type,
            amount,
            ...(origin
              ? {
                  correctionId: origin.correctionId.toHexString(),
                  requestedById: origin.requestedById.toHexString(),
                }
              : {}),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    },
    result: async () => {
      const [afterTxn, afterAccount] = await Promise.all([
        SavingsTxnModel.findById(txnId),
        SavingsAccountModel.findById(accountId),
      ]);
      if (!afterTxn || !afterAccount) {
        throw new AppError('NOT_FOUND', 'Transaction not found', 404);
      }
      return { target: toPublicSavingsAccount(afterAccount), txn: toPublicTxn(afterTxn) };
    },
  };
};

export async function listSavingsTxnTrash(
  _actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListTrashQuery,
): Promise<{ items: TrashedSavingsTxn[]; page: number; limit: number; total: number }> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const filter = { accountId, deletedAt: { $ne: null } };
  const [txns, total] = await Promise.all([
    SavingsTxnModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsTxnModel.countDocuments(filter),
  ]);
  return { items: txns.map(toTrashedTxn), page: query.page, limit: query.limit, total };
}

// ---------------------------------------------------------------- receipts

export interface ReceiptFile {
  buffer: Buffer;
  filename: string;
}

const TXN_TITLES: Record<SavingsTxn['type'], string> = {
  deposit: 'Savings Deposit',
  withdrawal: 'Savings Withdrawal',
  closure: 'Savings Account Closure',
};

/**
 * Receipt for one savings movement. balanceAfter is read straight off the
 * stored transaction, so a receipt reprinted later still shows the balance as
 * it stood that day.
 */
export async function txnReceipt(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  txnId: Types.ObjectId,
): Promise<ReceiptFile> {
  const account = await SavingsAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);

  const txn = await SavingsTxnModel.findOne({ _id: txnId, accountId, ...NOT_TRASHED });
  if (!txn) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  const customer = await CustomerModel.findById(account.customerId);
  const staff = await UserModel.findById(txn.recordedById).select('name');

  const lines: ReceiptLine[] = [];
  if (txn.fee !== undefined && txn.fee > 0) {
    lines.push({ label: 'Withdrawal fee', value: formatGhs(txn.fee) });
    lines.push({ label: 'Total debited', value: formatGhs(txn.amount + txn.fee) });
  }
  lines.push({ label: 'Balance after', value: formatGhs(txn.balanceAfter), emphasis: true });
  if (txn.type === 'deposit') {
    lines.push({ label: 'Payment method', value: txn.channel });
  }
  if (txn.type === 'closure') {
    lines.push({ label: 'Account status', value: 'Closed' });
  } else {
    // The minimum balance only comes out on closure, so it is worth stating.
    lines.push({
      label: 'Withdrawable now',
      value: formatGhs(availableToWithdraw(txn.balanceAfter)),
    });
  }
  lines.push({ label: 'Account type', value: account.accountType });

  const prefix = txn.type === 'deposit' ? 'VD' : 'VW';
  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber(prefix, txn._id),
    kind: txn.type === 'deposit' ? 'deposit' : 'withdrawal',
    title: TXN_TITLES[txn.type],
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: account.accountNumber,
    amount: txn.amount,
    lines,
    recordedByName: staff?.name ?? 'Yadah staff',
    at: txn.createdAt,
    reference: txn._id.toHexString(),
  });
  return { buffer, filename: `savings-${txn.type}-${receiptNumber(prefix, txn._id)}.pdf` };
}
