import { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import {
  CapitalEntryModel,
  CashAccountModel,
  CommissionModel,
  CommissionMoveModel,
  ExpenseModel,
  FixedAssetModel,
  type CashAccount,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { transactionGroups } from '../reports/transactions.service.js';
import { commissionBalance } from '../commissions/commissions.service.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { CreateCashAccountBody } from './accounting.schemas.js';

/**
 * Where the company's own money sits, and how much of it there is.
 *
 * Balances are DERIVED on every read rather than stored:
 *
 *   opening balance
 *   + customer money in on this account's channel
 *   − customer money out on this account's channel
 *   + capital contributions into it
 *   − drawings out of it
 *   − expenses paid from it
 *   − fixed assets bought from it
 *   + proceeds from assets it was paid into
 *   − commission earned on this channel (it sits in Yadah's commission account)
 *   + commission moved into it
 *
 * Commission is counted out of the account it physically landed in, whatever
 * the date, and held apart in the commission account until office staff move
 * it to an account of their choosing (client decision, 7 Oct 2026) — so the
 * company's cash total never changes, and nothing is counted twice.
 *
 * Nothing writes a running total, so no missed update can leave a stored
 * balance quietly wrong — the cost is a handful of aggregates per read, which
 * is nothing at this scale.
 *
 * The channel is what ties customer money to an account without every existing
 * money path having to post to one: susu deposits, savings withdrawals, loan
 * disbursements and the rest already record whether they were cash, Paystack
 * or mobile money.
 */

export interface PublicCashAccount {
  id: string;
  name: string;
  kind: string;
  channel: string;
  openingBalance: number;
  openingDate: string;
  bankName?: string;
  accountNumber?: string;
  status: string;
}

export function toPublicCashAccount(a: CashAccount): PublicCashAccount {
  return {
    id: a._id.toHexString(),
    name: a.name,
    kind: a.kind,
    channel: a.channel,
    openingBalance: a.openingBalance,
    openingDate: accraDay(a.openingDate),
    ...(a.bankName !== undefined ? { bankName: a.bankName } : {}),
    ...(a.accountNumber !== undefined ? { accountNumber: a.accountNumber } : {}),
    status: a.status,
  };
}

export interface CashAccountBalance extends PublicCashAccount {
  movement: {
    /** Customer money received on this channel since the opening date. */
    customerIn: number;
    /** Customer money paid out on this channel since the opening date. */
    customerOut: number;
    capitalIn: number;
    drawings: number;
    expensesPaid: number;
    assetPurchases: number;
    assetDisposalProceeds: number;
    /** Commission and fees earned on this channel — held in the commission account. */
    commissionHeld: number;
    /** Commission moved from the commission account into this one. */
    commissionMovedIn: number;
  };
  /** Opening balance plus every movement above. May be negative if overdrawn. */
  balance: number;
}

export async function createAccount(
  actor: AccessTokenPayload,
  body: CreateCashAccountBody,
  requestId?: string,
): Promise<PublicCashAccount> {
  const clash = await CashAccountModel.findOne({
    channel: body.channel,
    status: 'active',
    ...NOT_TRASHED,
  });
  if (clash) {
    throw new AppError(
      'CHANNEL_TAKEN',
      `“${clash.name}” already receives ${body.channel} money — two accounts on one channel would each claim the same transactions`,
      409,
      { existingAccountId: clash._id.toHexString() },
    );
  }

  const account = await CashAccountModel.create({
    name: body.name,
    kind: body.kind,
    channel: body.channel,
    openingBalance: body.openingBalance,
    openingDate: new Date(`${body.openingDate}T00:00:00.000Z`),
    ...(body.bankName !== undefined ? { bankName: body.bankName } : {}),
    ...(body.accountNumber !== undefined ? { accountNumber: body.accountNumber } : {}),
    createdById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: 'cash-account.create',
    entityType: 'cash-account',
    entityId: account._id,
    amountAfter: body.openingBalance,
    after: { name: body.name, channel: body.channel, openingBalance: body.openingBalance },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return toPublicCashAccount(account);
}

/**
 * The balance of one account on a given day (default: today).
 *
 * `asOf` is exclusive of nothing — it is an inclusive Accra day, so passing a
 * month end gives the closing balance for that month.
 */
export async function accountBalance(
  account: CashAccount,
  asOf: string = accraDay(),
): Promise<CashAccountBalance> {
  const openingDay = accraDay(account.openingDate);
  const accountId = account._id;

  // Customer money on this channel. transactionGroups already excludes
  // internal transfer legs from the in/out totals, so a susu → savings move
  // never looks like cash arriving.
  const groups = await transactionGroups(openingDay, asOf);
  let customerIn = 0;
  let customerOut = 0;
  for (const g of groups.groups) {
    // Loan disbursements carry a literal 'cash' channel; every other row
    // reports the channel it was recorded on.
    if (g.direction === 'in' && matchesChannel(account.channel, g.channel)) customerIn += g.amount;
    if (g.direction === 'out' && matchesChannel(account.channel, g.channel)) {
      customerOut += g.amount;
    }
  }

  const [capital, expenses, assets, disposals, commissionHeld, commissionMovedIn] =
    await Promise.all([
      CapitalEntryModel.aggregate<{ _id: string; amount: number }>([
        {
          $match: {
            cashAccountId: accountId,
            occurredOn: { $gte: openingDay, $lte: asOf },
            ...NOT_TRASHED,
          },
        },
        { $group: { _id: '$kind', amount: { $sum: '$amount' } } },
      ]),
      ExpenseModel.aggregate<{ amount: number }>([
        {
          $match: {
            cashAccountId: accountId,
            status: 'paid',
            paidOn: { $gte: openingDay, $lte: asOf },
            ...NOT_TRASHED,
          },
        },
        { $group: { _id: null, amount: { $sum: '$amount' } } },
      ]),
      FixedAssetModel.aggregate<{ amount: number }>([
        {
          $match: {
            cashAccountId: accountId,
            acquiredOn: { $gte: openingDay, $lte: asOf },
            ...NOT_TRASHED,
          },
        },
        { $group: { _id: null, amount: { $sum: '$cost' } } },
      ]),
      FixedAssetModel.aggregate<{ amount: number }>([
        {
          $match: {
            cashAccountId: accountId,
            status: 'disposed',
            disposedOn: { $gte: openingDay, $lte: asOf },
            ...NOT_TRASHED,
          },
        },
        { $group: { _id: null, amount: { $sum: { $ifNull: ['$disposalProceeds', 0] } } } },
      ]),
      // All of it, not just since the opening date: an opening count of the
      // drawer included commission not yet moved, and that is the commission
      // account's now.
      CommissionModel.aggregate<{ amount: number }>([
        { $match: { channel: account.channel, takenAt: { $lt: dayEnd(asOf) } } },
        { $group: { _id: null, amount: { $sum: '$amount' } } },
      ]),
      CommissionMoveModel.aggregate<{ amount: number }>([
        { $match: { cashAccountId: accountId, occurredOn: { $lte: asOf }, ...NOT_TRASHED } },
        { $group: { _id: null, amount: { $sum: '$amount' } } },
      ]),
    ]);

  const byKind = new Map(capital.map((c) => [c._id, c.amount]));
  const movement = {
    customerIn,
    customerOut,
    capitalIn: byKind.get('contribution') ?? 0,
    drawings: byKind.get('drawing') ?? 0,
    expensesPaid: expenses[0]?.amount ?? 0,
    assetPurchases: assets[0]?.amount ?? 0,
    assetDisposalProceeds: disposals[0]?.amount ?? 0,
    commissionHeld: commissionHeld[0]?.amount ?? 0,
    commissionMovedIn: commissionMovedIn[0]?.amount ?? 0,
  };

  const balance =
    account.openingBalance +
    movement.customerIn -
    movement.customerOut +
    movement.capitalIn -
    movement.drawings -
    movement.expensesPaid -
    movement.assetPurchases +
    movement.assetDisposalProceeds -
    movement.commissionHeld +
    movement.commissionMovedIn;

  return { ...toPublicCashAccount(account), movement, balance };
}

/**
 * Whether a transaction's channel belongs to this account.
 *
 * A null channel means the record did not store one — loan disbursements and
 * susu payouts, which are handed over at the office. Those count as cash.
 */
/** The first instant after an inclusive Accra day. */
function dayEnd(day: string): Date {
  const window = createdAtFilter(undefined, day);
  if (!window?.$lt) throw new Error(`no end for day ${day}`);
  return window.$lt;
}

function matchesChannel(accountChannel: string, txnChannel: string | null): boolean {
  return (txnChannel ?? 'cash') === accountChannel;
}

export interface CashPosition {
  asOf: string;
  accounts: CashAccountBalance[];
  /**
   * Yadah's commission account at the close of the day: commission and fees
   * taken out of the accounts above and not yet moved back into one.
   */
  commission: number;
  /** Every account plus the commission account — the cash line on the balance sheet. */
  total: number;
}

export async function cashPosition(asOf: string = accraDay()): Promise<CashPosition> {
  const accounts = await CashAccountModel.find({ status: 'active', ...NOT_TRASHED }).sort({
    kind: 1,
    name: 1,
  });
  const [balances, commission] = await Promise.all([
    Promise.all(accounts.map((a) => accountBalance(a, asOf))),
    commissionBalance(asOf),
  ]);
  return {
    asOf,
    accounts: balances,
    commission: commission.balance,
    total: balances.reduce((sum, b) => sum + b.balance, 0) + commission.balance,
  };
}

export async function listAccounts(): Promise<PublicCashAccount[]> {
  const accounts = await CashAccountModel.find({ ...NOT_TRASHED }).sort({ kind: 1, name: 1 });
  return accounts.map(toPublicCashAccount);
}

export async function getAccountOrThrow(id: Types.ObjectId): Promise<CashAccount> {
  const account = await CashAccountModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Cash account not found', 404);
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'That cash account is closed', 422);
  }
  return account;
}
