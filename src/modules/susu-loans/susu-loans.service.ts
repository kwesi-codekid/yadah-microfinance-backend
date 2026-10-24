import mongoose, { Types } from 'mongoose';
import { MongoServerError } from 'mongodb';
import { nextAccountNumber } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { assertCanActOnCustomer, withCustomerScope } from '../../lib/customer-scope.js';
import { AppError } from '../../lib/errors.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { logger } from '../../lib/logger.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay } from '../../lib/time.js';
import {
  CustomerModel,
  LoanModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuLoanAccountModel,
  SusuLoanTxnModel,
  UserModel,
  type SusuLoanAccount,
  type SusuLoanTxn,
  type SusuLoanTxnType,
} from '../../models/index.js';
import { NOT_TRASHED, type Channel } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { ListAccountsQuery, ListTxnsQuery } from './susu-loans.schemas.js';

/**
 * The susu loan account (client decision, 23 Oct 2026): the customer's loan
 * passbook. It replaces loan savings and sits with susu, but takes none of
 * susu's rules — no plans, no cycles, no commission. Paid into in any amount
 * at the office; never withdrawn. Its money leaves only to repay the
 * customer's loan, and, once that loan is paid off, what is left goes to
 * their savings. See models/susu-loan-account.model.ts.
 */

export interface PublicSusuLoanAccount {
  id: string;
  accountNumber: string;
  customerId: string;
  /** Joined on the listing and the account page. */
  customerName?: string;
  balance: number;
  status: 'active' | 'closed';
  openedAt: Date;
  closedAt?: Date;
}

export function toPublicSusuLoanAccount(a: SusuLoanAccount): PublicSusuLoanAccount {
  return {
    id: a._id.toHexString(),
    accountNumber: a.accountNumber,
    customerId: a.customerId.toHexString(),
    balance: a.balance,
    status: a.status,
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
  };
}

export interface PublicSusuLoanTxn {
  id: string;
  accountId: string;
  customerId: string;
  type: SusuLoanTxnType;
  amount: number;
  balanceAfter: number;
  channel: string;
  loanId?: string;
  /** The loan's number, joined on the listing. */
  loanNumber?: string;
  savingsAccountId?: string;
  accraDay: string;
  recordedById: string;
  createdAt: Date;
}

export function toPublicSusuLoanTxn(t: SusuLoanTxn): PublicSusuLoanTxn {
  return {
    id: t._id.toHexString(),
    accountId: t.accountId.toHexString(),
    customerId: t.customerId.toHexString(),
    type: t.type,
    amount: t.amount,
    balanceAfter: t.balanceAfter,
    channel: t.channel,
    ...(t.loanId ? { loanId: t.loanId.toHexString() } : {}),
    ...(t.savingsAccountId ? { savingsAccountId: t.savingsAccountId.toHexString() } : {}),
    accraDay: t.accraDay,
    recordedById: t.recordedById.toHexString(),
    createdAt: t.createdAt,
  };
}

export interface SusuLoanTxnResult {
  txn: PublicSusuLoanTxn;
  account: PublicSusuLoanAccount;
  replayed: boolean;
}

// ---------------------------------------------------------------- money moves

const AUDIT_ACTIONS: Record<SusuLoanTxnType, string> = {
  deposit: 'susu-loan.deposit.record',
  repayment: 'susu-loan.repayment.record',
  leftover: 'susu-loan.leftover.record',
  refund: 'susu-loan.refund.record',
};

/**
 * Moves money on a susu loan account INSIDE the caller's transaction: the
 * balance (only if it is still what was read, never below nothing), the row,
 * and the audit entry. Every movement goes through here.
 */
async function moveInTxn(
  session: mongoose.ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  delta: number,
  row: {
    type: SusuLoanTxnType;
    channel: Channel;
    idempotencyKey: string;
    loanId?: Types.ObjectId;
    savingsAccountId?: Types.ObjectId;
  },
  requestId?: string,
): Promise<{ account: SusuLoanAccount; txn: SusuLoanTxn }> {
  const account = await SusuLoanAccountModel.findOne({
    _id: accountId,
    status: 'active',
    ...NOT_TRASHED,
  }).session(session);
  if (!account) {
    throw new AppError('ACCOUNT_NOT_ACTIVE', 'Susu loan account is not active', 422);
  }
  if (account.balance + delta < 0) {
    throw new AppError(
      'EXCEEDS_AVAILABLE',
      `Only ${formatGhs(account.balance)} is in the susu loan account`,
      422,
      { available: account.balance },
    );
  }
  const balanceAfter = account.balance + delta;
  const upd = await SusuLoanAccountModel.updateOne(
    { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
    { $inc: { balance: delta } },
    { session },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
  }
  const [txn] = await SusuLoanTxnModel.create(
    [
      {
        accountId: account._id,
        customerId: account.customerId,
        type: row.type,
        amount: Math.abs(delta),
        balanceAfter,
        channel: row.channel,
        ...(row.loanId ? { loanId: row.loanId } : {}),
        ...(row.savingsAccountId ? { savingsAccountId: row.savingsAccountId } : {}),
        accraDay: accraDay(),
        recordedById: new Types.ObjectId(actor.sub),
        idempotencyKey: row.idempotencyKey,
      },
    ],
    { session },
  );
  await audit(
    {
      actorId: actor.sub,
      action: AUDIT_ACTIONS[row.type],
      entityType: 'susu-loan-account',
      entityId: account._id,
      amountBefore: account.balance,
      amountAfter: balanceAfter,
      after: {
        amount: Math.abs(delta),
        ...(row.loanId ? { loanId: row.loanId.toHexString() } : {}),
        ...(row.savingsAccountId ? { savingsAccountId: row.savingsAccountId.toHexString() } : {}),
      },
      ...(requestId !== undefined ? { requestId } : {}),
    },
    session,
  );
  return { account, txn: txn as SusuLoanTxn };
}

/** The customer's open susu loan account, if they have one — there is at most one. */
export async function findSusuLoanAccount(
  customerId: Types.ObjectId,
): Promise<SusuLoanAccount | null> {
  return SusuLoanAccountModel.findOne({ customerId, status: 'active', ...NOT_TRASHED });
}

/**
 * Takes money out of a susu loan account to repay its holder's loan, INSIDE
 * the caller's transaction — the loan side is written in the same one, so
 * the money is never out of the account without being on the loan.
 */
export async function debitSusuLoanInTxn(
  session: mongoose.ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  loanId: Types.ObjectId,
  idempotencyKey: string,
  requestId?: string,
): Promise<{ balanceAfter: number }> {
  const { txn } = await moveInTxn(
    session,
    actor,
    accountId,
    -amount,
    {
      type: 'repayment',
      channel: 'transfer',
      idempotencyKey: `susu-loan:${idempotencyKey}`,
      loanId,
    },
    requestId,
  );
  return { balanceAfter: txn.balanceAfter };
}

/**
 * Puts a repayment back into the susu loan account it came from, INSIDE the
 * caller's transaction, when the loan or the repayment is deleted. A new row
 * dated today rather than an erased one, so every later balance stays true.
 */
export async function refundToSusuLoanInTxn(
  session: mongoose.ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  loanId: Types.ObjectId,
  idempotencyKey: string,
  requestId?: string,
): Promise<{ balanceAfter: number }> {
  const { txn } = await moveInTxn(
    session,
    actor,
    accountId,
    amount,
    { type: 'refund', channel: 'transfer', idempotencyKey, loanId },
    requestId,
  );
  return { balanceAfter: txn.balanceAfter };
}

/**
 * Once a loan is fully repaid, what is left in the customer's susu loan
 * account moves to their savings account (client decision, 23 Oct 2026).
 * Both rows are transfer legs, out of the cash totals.
 *
 * Done once per loan — the rows' idempotency keys name it — so money paid in
 * afterwards, towards the next loan, stays put. Nothing moves while another
 * loan of theirs is still open, or when they have no savings account to take
 * it: it waits where it is. Returns what moved, if anything.
 */
export async function moveSusuLoanLeftover(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  loanId: Types.ObjectId,
  requestId?: string,
): Promise<{ amount: number; toAccountId: Types.ObjectId } | null> {
  const from = await findSusuLoanAccount(customerId);
  if (!from || from.balance <= 0) return null;
  const stillOpen = await LoanModel.exists({
    customerId,
    status: { $in: ['active', 'arrears'] },
    ...NOT_TRASHED,
  });
  if (stillOpen) return null;
  const to = await SavingsAccountModel.findOne({
    customerId,
    accountType: { $in: ['standard', 'student'] },
    status: 'active',
    ...NOT_TRASHED,
  }).sort({ createdAt: 1 });
  if (!to) return null;
  const key = `susu-loan-leftover:${loanId.toHexString()}`;
  if (await SusuLoanTxnModel.exists({ idempotencyKey: key })) return null;

  const amount = from.balance;
  const session = await mongoose.startSession();
  let savingsAfter = 0;
  let loanBookAfter = 0;
  try {
    await session.withTransaction(async () => {
      const { txn } = await moveInTxn(
        session,
        actor,
        from._id,
        -amount,
        {
          type: 'leftover',
          channel: 'transfer',
          idempotencyKey: key,
          loanId,
          savingsAccountId: to._id,
        },
        requestId,
      );
      loanBookAfter = txn.balanceAfter;
      const target = await SavingsAccountModel.findOne({
        _id: to._id,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!target) throw new AppError('ACCOUNT_NOT_ACTIVE', 'Savings account is not open', 422);
      savingsAfter = target.balance + amount;
      const upd = await SavingsAccountModel.updateOne(
        { _id: target._id, balance: target.balance },
        { $inc: { balance: amount } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      await SavingsTxnModel.create(
        [
          {
            accountId: target._id,
            customerId,
            type: 'deposit',
            amount,
            balanceAfter: savingsAfter,
            channel: 'transfer',
            accraDay: accraDay(),
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey: `${key}:in`,
          },
        ],
        { session },
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'savings.deposit.record',
          entityType: 'savings-account',
          entityId: target._id,
          amountBefore: target.balance,
          amountAfter: savingsAfter,
          after: { amount, via: 'susu-loan-leftover', loanId: loanId.toHexString() },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } catch (err) {
    // Two payoffs racing: the other one moved it.
    if (err instanceof MongoServerError && err.code === 11000) return null;
    throw err;
  } finally {
    await session.endSession();
  }

  emitAdminEvent('susu-loan.txn', {
    accountId: from._id.toHexString(),
    customerId: customerId.toHexString(),
    type: 'leftover',
    amount,
    balance: loanBookAfter,
  });
  emitAdminEvent('savings.txn', {
    accountId: to._id.toHexString(),
    customerId: customerId.toHexString(),
    type: 'deposit',
    amount,
    balance: savingsAfter,
  });
  return { amount, toAccountId: to._id };
}

// ---------------------------------------------------------------- accounts

export async function openAccount(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  initialDeposit: number | undefined,
  idempotencyKey: string | undefined,
  requestId?: string,
): Promise<{ account: PublicSusuLoanAccount; initialTxn?: PublicSusuLoanTxn }> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }
  const existing = await findSusuLoanAccount(customerId);
  if (existing) {
    throw new AppError(
      'SUSU_LOAN_EXISTS',
      `${customer.fullName} already has a susu loan account (${existing.accountNumber})`,
      409,
      { accountId: existing._id.toHexString() },
    );
  }

  // Reserved before the session opens: the counter must not join the money
  // transaction (see lib/account-number.ts).
  const accountNumber = await nextAccountNumber('SL');
  const session = await mongoose.startSession();
  let account!: SusuLoanAccount;
  let initialTxn: SusuLoanTxn | undefined;
  try {
    await session.withTransaction(async () => {
      const [created] = await SusuLoanAccountModel.create(
        [{ accountNumber, customerId, balance: 0, openedById: new Types.ObjectId(actor.sub) }],
        { session },
      );
      account = created as SusuLoanAccount;
      await audit(
        {
          actorId: actor.sub,
          action: 'susu-loan.account.open',
          entityType: 'susu-loan-account',
          entityId: account._id,
          after: { accountNumber, customerId: customerId.toHexString() },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
      if (initialDeposit !== undefined && initialDeposit > 0) {
        ({ txn: initialTxn } = await moveInTxn(
          session,
          actor,
          account._id,
          initialDeposit,
          {
            type: 'deposit',
            channel: 'cash',
            idempotencyKey: idempotencyKey ?? `open:${accountNumber}`,
          },
          requestId,
        ));
      }
    });
  } catch (err) {
    if (err instanceof MongoServerError && err.code === 11000) {
      throw new AppError(
        'SUSU_LOAN_EXISTS',
        `${customer.fullName} already has a susu loan account`,
        409,
      );
    }
    throw err;
  } finally {
    await session.endSession();
  }

  if (initialTxn) {
    const { sweepSusuLoan } = await import('../../lib/susu-loan.js');
    await sweepSusuLoan(customerId);
  }
  const after = (await SusuLoanAccountModel.findById(account._id)) ?? account;
  return {
    account: { ...toPublicSusuLoanAccount(after), customerName: customer.fullName },
    ...(initialTxn ? { initialTxn: toPublicSusuLoanTxn(initialTxn) } : {}),
  };
}

export async function listAccounts(
  actor: AccessTokenPayload,
  query: ListAccountsQuery,
): Promise<{ items: PublicSusuLoanAccount[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    const customerIds = await fuzzyCustomerIds(query.search);
    const or: Record<string, unknown>[] = [{ customerId: { $in: customerIds } }];
    if (/^(SL)?\d{2,12}$/i.test(query.search)) {
      or.push({ accountNumber: { $regex: `^${query.search.toUpperCase()}` } });
    }
    filter.$or = or;
  }
  const scoped = await withCustomerScope(actor, filter);
  const [accounts, total] = await Promise.all([
    SusuLoanAccountModel.find(scoped)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuLoanAccountModel.countDocuments(scoped),
  ]);
  const ids = [...new Set(accounts.map((a) => a.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: ids } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: accounts.map((a) => ({
      ...toPublicSusuLoanAccount(a),
      customerName: names.get(a.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

async function loadAccount(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<SusuLoanAccount> {
  const account = await SusuLoanAccountModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);
  return account;
}

export async function getAccount(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSusuLoanAccount> {
  const account = await loadAccount(actor, id);
  const customer = await CustomerModel.findById(account.customerId, { fullName: 1 });
  return { ...toPublicSusuLoanAccount(account), customerName: customer?.fullName ?? '' };
}

export async function listTxns(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  query: ListTxnsQuery,
): Promise<{ items: PublicSusuLoanTxn[]; page: number; limit: number; total: number }> {
  await loadAccount(actor, id);
  const filter: Record<string, unknown> = { accountId: id, ...NOT_TRASHED };
  if (query.type) filter.type = query.type;
  const [txns, total] = await Promise.all([
    SusuLoanTxnModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuLoanTxnModel.countDocuments(filter),
  ]);
  const loanIds = [...new Set(txns.flatMap((t) => (t.loanId ? [t.loanId.toHexString()] : [])))];
  const loans = await LoanModel.find({ _id: { $in: loanIds } }, { accountNumber: 1 });
  const numbers = new Map(loans.map((l) => [l._id.toHexString(), l.accountNumber]));
  return {
    items: txns.map((t) => {
      const loanNumber = t.loanId ? numbers.get(t.loanId.toHexString()) : undefined;
      return { ...toPublicSusuLoanTxn(t), ...(loanNumber ? { loanNumber } : {}) };
    }),
    page: query.page,
    limit: query.limit,
    total,
  };
}

/**
 * Money paid in at the office — any amount, any day (client decision, 23 Oct
 * 2026). A loan that is behind takes it at once (lib/susu-loan.ts); the reply
 * shows the account after that.
 */
export async function deposit(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<SusuLoanTxnResult> {
  const existing = await SusuLoanTxnModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SusuLoanAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return {
      txn: toPublicSusuLoanTxn(existing),
      account: toPublicSusuLoanAccount(account),
      replayed: true,
    };
  }
  const pre = await loadAccount(actor, id);
  const session = await mongoose.startSession();
  let txn!: SusuLoanTxn;
  try {
    await session.withTransaction(async () => {
      ({ txn } = await moveInTxn(
        session,
        actor,
        pre._id,
        amount,
        { type: 'deposit', channel, idempotencyKey },
        requestId,
      ));
    });
  } finally {
    await session.endSession();
  }

  const { sweepSusuLoan } = await import('../../lib/susu-loan.js');
  await sweepSusuLoan(pre.customerId);

  const after = await SusuLoanAccountModel.findById(pre._id);
  if (!after) throw new AppError('NOT_FOUND', 'Account not found', 404);
  emitAdminEvent('susu-loan.txn', {
    accountId: pre._id.toHexString(),
    customerId: pre.customerId.toHexString(),
    type: 'deposit',
    amount,
    balance: after.balance,
  });
  const customer = await CustomerModel.findById(pre.customerId, { phone: 1 });
  if (customer?.phone) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-loan-deposit',
      message: `Yadah: ${formatGhs(amount)} received into your susu loan account ${pre.accountNumber}.`,
      relatedEntityType: 'susu-loan-account',
      relatedEntityId: pre._id,
    }).catch((err: unknown) => {
      logger.warn({ err }, 'susu loan deposit sms not queued');
    });
  }
  return {
    txn: toPublicSusuLoanTxn(txn),
    account: toPublicSusuLoanAccount(after),
    replayed: false,
  };
}

/** Closes an empty account. Money in it can only go to the loan, never out. */
export async function closeAccount(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
  requestId?: string,
): Promise<PublicSusuLoanAccount> {
  const pre = await loadAccount(actor, id);
  if (pre.status !== 'active') {
    throw new AppError('ACCOUNT_NOT_ACTIVE', 'Account is already closed', 422);
  }
  if (pre.balance > 0) {
    throw new AppError(
      'SUSU_LOAN_NOT_EMPTY',
      `${formatGhs(pre.balance)} is still in the account — it can only go to a loan`,
      422,
    );
  }
  const now = new Date();
  const upd = await SusuLoanAccountModel.updateOne(
    { _id: pre._id, status: 'active', balance: 0 },
    { $set: { status: 'closed', closedAt: now, closedById: new Types.ObjectId(actor.sub) } },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
  }
  await audit({
    actorId: actor.sub,
    action: 'susu-loan.account.close',
    entityType: 'susu-loan-account',
    entityId: pre._id,
    before: { status: 'active' },
    after: { status: 'closed' },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  const after = await SusuLoanAccountModel.findById(pre._id);
  return toPublicSusuLoanAccount(after ?? pre);
}

// ---------------------------------------------------------------- receipts

const TXN_TITLES: Record<SusuLoanTxnType, string> = {
  deposit: 'Susu loan deposit',
  repayment: 'Susu loan — paid to loan',
  leftover: 'Susu loan — moved to savings',
  refund: 'Susu loan — repayment returned',
};

export async function txnReceipt(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  txnId: Types.ObjectId,
): Promise<{ buffer: Buffer; filename: string }> {
  const account = await loadAccount(actor, accountId);
  const txn = await SusuLoanTxnModel.findOne({ _id: txnId, accountId, ...NOT_TRASHED });
  if (!txn) throw new AppError('NOT_FOUND', 'Transaction not found', 404);
  const customer = await CustomerModel.findById(account.customerId);
  const staff = await UserModel.findById(txn.recordedById).select('name');
  const loan = txn.loanId ? await LoanModel.findById(txn.loanId, { accountNumber: 1 }) : null;

  const lines: ReceiptLine[] = [
    { label: 'Balance after', value: formatGhs(txn.balanceAfter), emphasis: true },
  ];
  if (loan) lines.push({ label: 'Loan', value: loan.accountNumber ?? loan._id.toHexString() });
  if (txn.type === 'deposit') lines.push({ label: 'Payment method', value: txn.channel });

  const prefix = txn.type === 'deposit' ? 'LD' : 'LW';
  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber(prefix, txn._id),
    kind: txn.type === 'deposit' || txn.type === 'refund' ? 'deposit' : 'withdrawal',
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
  return { buffer, filename: `susu-loan-${txn.type}-${receiptNumber(prefix, txn._id)}.pdf` };
}
