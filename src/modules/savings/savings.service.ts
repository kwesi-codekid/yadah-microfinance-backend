import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { generateAccountNumber, SAVINGS_ACCOUNT_DIGITS } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  SavingsAccountModel,
  SavingsTxnModel,
  type Customer,
  type SavingsAccount,
  type SavingsTxn,
} from '../../models/index.js';
import {
  availableToWithdraw,
  computeSavingsClosure,
  computeWithdrawal,
} from '../../domain/savings.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { Channel } from '../../models/shared.js';
import type { ListAccountsQuery, ListTxnsQuery } from './savings.schemas.js';

// ---------------------------------------------------------------- shapes

export interface PublicSavingsAccount {
  id: string;
  accountNumber: string;
  customerId: string;
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
    balance: a.balance,
    availableToWithdraw: a.status === 'active' ? availableToWithdraw(a.balance) : 0,
    status: a.status,
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
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

function toPublicTxn(t: SavingsTxn): PublicSavingsTxn {
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

// ---------------------------------------------------------------- helpers

async function loadCustomer(customerId: Types.ObjectId): Promise<Customer> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return customer;
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
  requestId?: string,
): Promise<{ account: PublicSavingsAccount; initialTxn?: PublicSavingsTxn }> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }

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
                accountNumber: generateAccountNumber(SAVINGS_ACCOUNT_DIGITS),
                customerId,
                balance: initialDeposit ?? 0,
                openedById: new Types.ObjectId(actor.sub),
              },
            ],
            { session },
          );
          break;
        } catch (err) {
          // Rare random collision on the unique account number — regenerate.
          if (err instanceof MongoServerError && err.code === 11000 && attempt < 5) continue;
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
  _actor: AccessTokenPayload,
  query: ListAccountsQuery,
): Promise<{ items: PublicSavingsAccount[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.accountNumber !== undefined) filter.accountNumber = query.accountNumber;

  const [accounts, total] = await Promise.all([
    SavingsAccountModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsAccountModel.countDocuments(filter),
  ]);
  return {
    items: accounts.map(toPublicSavingsAccount),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export async function getAccount(
  _actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSavingsAccount> {
  const account = await SavingsAccountModel.findById(id);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  return toPublicSavingsAccount(account);
}

export async function listTransactions(
  _actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListTxnsQuery,
): Promise<{ items: PublicSavingsTxn[]; page: number; limit: number; total: number }> {
  const account = await SavingsAccountModel.findById(accountId);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);

  const [txns, total] = await Promise.all([
    SavingsTxnModel.find({ accountId })
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SavingsTxnModel.countDocuments({ accountId }),
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
): Promise<TxnResult> {
  const existing = await SavingsTxnModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SavingsAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { txn: toPublicTxn(existing), account: toPublicSavingsAccount(account), replayed: true };
  }

  const pre = await SavingsAccountModel.findById(accountId);
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await loadCustomer(pre.customerId);

  const session = await mongoose.startSession();
  let txn!: SavingsTxn;
  try {
    await session.withTransaction(async () => {
      const account = await SavingsAccountModel.findOne({
        _id: accountId,
        status: 'active',
      }).session(session);
      if (!account) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);

      const upd = await SavingsAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance },
        { $inc: { balance: amount } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      const [created] = await SavingsTxnModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            type: 'deposit',
            amount,
            balanceAfter: account.balance + amount,
            channel,
            accraDay: accraDay(),
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
          },
        ],
        { session },
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
): Promise<TxnResult> {
  const existing = await SavingsTxnModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SavingsAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { txn: toPublicTxn(existing), account: toPublicSavingsAccount(account), replayed: true };
  }

  const pre = await SavingsAccountModel.findById(accountId);
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  let txn!: SavingsTxn;
  try {
    await session.withTransaction(async () => {
      const account = await SavingsAccountModel.findOne({
        _id: accountId,
        status: 'active',
      }).session(session);
      if (!account) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is not active', 422);

      const today = accraDay();
      const todayCashOut = await SavingsTxnModel.findOne({
        accountId: account._id,
        accraDay: today,
        type: { $in: ['withdrawal', 'closure'] },
      }).session(session);
      if (todayCashOut) {
        throw new AppError(
          'WITHDRAWAL_LIMIT',
          'Only one withdrawal is allowed per day on an account',
          409,
        );
      }

      let computation;
      try {
        computation = computeWithdrawal(account.balance, amount);
      } catch (err) {
        if (err instanceof RangeError) {
          throw new AppError('EXCEEDS_AVAILABLE', 'Amount exceeds the available balance', 422, {
            available: availableToWithdraw(account.balance),
          });
        }
        throw err;
      }

      const upd = await SavingsAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance },
        { $inc: { balance: -computation.totalDebit } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
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
            accraDay: today,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
          },
        ],
        { session },
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
  const pre = await SavingsAccountModel.findById(accountId);
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
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);

      const today = accraDay();
      const todayCashOut = await SavingsTxnModel.findOne({
        accountId: account._id,
        accraDay: today,
        type: { $in: ['withdrawal', 'closure'] },
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
        { _id: account._id, status: 'active', balance: account.balance },
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
