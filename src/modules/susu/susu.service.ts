import mongoose, { Types, type ClientSession } from 'mongoose';
import {
  accountRef,
  bareAccountNumber,
  cycleMonthOf,
  nextAccountNumber,
  withCycleMonth,
  type CycleMonth,
} from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import type { CorrectionOrigin, CorrectionPreparer } from '../../lib/corrections.js';
import { escapeRegex, fuzzyCustomerIds } from '../../lib/fuzzy.js';
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
  UserModel,
  type Customer,
  type SusuAccount,
  type SusuDeposit,
} from '../../models/index.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import {
  SUSU_CYCLE_DEPOSITS,
  SUSU_MAX_CARRY_ACCOUNTS,
  carriedAccountCount,
  computeClosure,
  computePartialWithdrawal,
  maxPartialWithdrawal,
  remainingDeposits,
  splitAcrossCycles,
  susuBalance,
} from '../../domain/susu.js';
import { assertCanActOnCustomer, withCustomerScope } from '../../lib/customer-scope.js';
import { notifyOffice } from '../../lib/notifications.js';
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
  /**
   * The customer's susu number with this cycle's month. Shared by every book
   * they hold — two cycles in one month read identically, which is the point.
   * Never use it to tell two accounts apart; use `id`, or show `ref`.
   */
  accountNumber: string;
  /** `_id` rendered for people: `260912134501-a3f9`. Always distinct. */
  ref: string;
  customerId: string;
  /** Present on list responses for display; joined from the customer. */
  customerName?: string;
  dailyAmount: number;
  depositsCount: number;
  cycleTarget: number;
  /** Running total paid in over the cycle — never decreases. */
  totalDeposited: number;
  /** Total taken out by partial withdrawals. */
  withdrawnAmount: number;
  /** totalDeposited − withdrawnAmount: what the account actually holds. */
  balance: number;
  /** What may be withdrawn today, keeping one day back for the commission. */
  availableToWithdraw: number;
  status: 'active' | 'completed' | 'pending-payout' | 'closed' | 'terminated';
  /** The month this cycle is called. Absent on accounts opened before it existed. */
  cycleMonth?: CycleMonth;
  /** Set when this cycle exists because another one overflowed into it. */
  carriedFromAccountId?: string;
  commissionAmount?: number;
  payoutAmount?: number;
  /** Undisbursed value awaiting withdrawal (pending-payout accounts). */
  payoutRemaining: number;
  openedAt: Date;
  closedAt?: Date;
}

export function toPublicAccount(a: SusuAccount): PublicSusuAccount {
  const balance = susuBalance(a.totalDeposited, a.withdrawnAmount);
  const open = a.status === 'active' || a.status === 'completed';
  return {
    id: a._id.toHexString(),
    accountNumber: a.accountNumber,
    ref: accountRef(a._id.toHexString(), a.createdAt),
    customerId: a.customerId.toHexString(),
    dailyAmount: a.dailyAmount,
    depositsCount: a.depositsCount,
    cycleTarget: SUSU_CYCLE_DEPOSITS,
    totalDeposited: a.totalDeposited,
    withdrawnAmount: a.withdrawnAmount,
    balance,
    // A stopped account has nothing left to withdraw against — its value is
    // already committed to payout.
    availableToWithdraw: open ? maxPartialWithdrawal(balance, a.dailyAmount) : 0,
    status: a.status,
    ...(a.cycleMonth !== undefined ? { cycleMonth: a.cycleMonth } : {}),
    ...(a.carriedFromAccountId
      ? { carriedFromAccountId: a.carriedFromAccountId.toHexString() }
      : {}),
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
    // The office reconciles rows one by one, and a customer's cycles all carry
    // the same number, so the spreadsheet needs the distinct one too.
    ref: item.ref,
    customerName: item.customerName ?? '',
    customerId: item.customerId,
    cycleMonth: item.cycleMonth ?? '',
    dailyAmount: item.dailyAmount,
    depositsCount: item.depositsCount,
    cycleTarget: item.cycleTarget,
    totalDeposited: item.totalDeposited,
    withdrawnAmount: item.withdrawnAmount,
    balance: item.balance,
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
  /** The other half of a payment that ran past the end of this cycle. */
  carriedToDepositId?: string;
  carriedToAccountId?: string;
  carriedFromDepositId?: string;
  carriedFromAccountId?: string;
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
    ...(d.carriedToDepositId ? { carriedToDepositId: d.carriedToDepositId.toHexString() } : {}),
    ...(d.carriedToAccountId ? { carriedToAccountId: d.carriedToAccountId.toHexString() } : {}),
    ...(d.carriedFromDepositId
      ? { carriedFromDepositId: d.carriedFromDepositId.toHexString() }
      : {}),
    ...(d.carriedFromAccountId
      ? { carriedFromAccountId: d.carriedFromAccountId.toHexString() }
      : {}),
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

/**
 * The customer's susu number — one per customer, for life.
 *
 * Resolution runs in three steps, and the order matters. A number already
 * claimed is returned as-is. Otherwise the customer's oldest book lends its
 * number, which is what makes every account opened before this rule collapse
 * onto the one the branch already knows; only a customer with no book at all
 * costs a fresh one from the monthly sequence.
 *
 * The claim itself is a single atomic update, not a read followed by a write:
 * `{ susuNumber: null }` matches a field that is missing as well as one that is
 * null, so exactly one of two simultaneous openings can set it and the loser
 * reads back the winner's. A sequence value spent by the loser is simply never
 * used, which the counter is explicitly built to tolerate.
 *
 * MUST NOT be called inside a mongoose session: it writes the counter, and the
 * counter deliberately stays out of caller transactions (see counter.model.ts).
 * `openAccount` opens no session, which is why it is the only caller.
 */
async function susuNumberFor(customerId: Types.ObjectId): Promise<string> {
  const held = await CustomerModel.findById(customerId, { susuNumber: 1 });
  if (held?.susuNumber) return held.susuNumber;

  // Oldest first, `_id` breaking a same-millisecond tie so the answer is the
  // same on every run — a migration and a live opening must not disagree.
  const oldest = await SusuAccountModel.findOne(
    { customerId },
    { accountNumber: 1, issuedNumber: 1 },
  ).sort({ createdAt: 1, _id: 1 });
  const candidate = oldest
    ? bareAccountNumber(oldest.issuedNumber ?? oldest.accountNumber)
    : await nextAccountNumber('SU');

  const claimed = await CustomerModel.findOneAndUpdate(
    { _id: customerId, susuNumber: null },
    { $set: { susuNumber: candidate } },
    { returnDocument: 'after' },
  );
  if (claimed?.susuNumber) return claimed.susuNumber;

  // Lost the race, or the customer vanished between the two reads. Re-read
  // rather than assume: the winner's number is the customer's, not ours.
  const winner = await CustomerModel.findById(customerId, { susuNumber: 1 });
  if (!winner?.susuNumber) {
    throw new AppError('NOT_FOUND', 'Customer not found', 404);
  }
  return winner.susuNumber;
}

/**
 * Open a cycle.
 *
 * The number is the customer's own, not this book's: their stem, plus the
 * month this cycle is *called*. `cycleMonth` defaults to the month we are
 * actually in but is allowed to differ from it, because a cycle opened in the
 * last days of August for a customer who thinks of it as their September
 * savings is a September cycle to everyone but the calendar.
 *
 * Opening a second book in a month the customer already has one is allowed and
 * produces an identical number. That is the branch's own practice and not a
 * mistake to guard against here.
 */
export async function openAccount(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  dailyAmount: number,
  cycleMonth: CycleMonth = cycleMonthOf(),
  requestId?: string,
): Promise<PublicSusuAccount> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }

  // No retry loop around this create. There used to be one, recovering from a
  // duplicate-key error by minting the next number — which under a per-customer
  // number would re-derive the same string forever. Nothing on the account is
  // unique any more, so the collision it existed for cannot happen.
  const account = await SusuAccountModel.create({
    accountNumber: withCycleMonth(await susuNumberFor(customerId), cycleMonth),
    customerId,
    dailyAmount,
    cycleMonth,
    openedById: new Types.ObjectId(actor.sub),
  });

  await audit({
    actorId: actor.sub,
    action: 'susu.account.open',
    entityType: 'susu-account',
    entityId: account._id,
    after: { dailyAmount, cycleMonth, customerId: customerId.toHexString() },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.account.opened', {
    id: account._id.toHexString(),
    accountNumber: account.accountNumber,
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    dailyAmount,
    cycleMonth,
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
  actor: AccessTokenPayload,
  query: ListAccountsQuery,
): Promise<AccountList> {
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.accountNumber !== undefined) {
    // A customer quoting SU26090005 means SU26090005-SEP; the cycle month is
    // part of the number but not part of what anyone reads back over a phone.
    //
    // `issuedNumber` is matched alongside it, and that is not a nicety: a
    // customer holding a receipt printed before their books were collapsed
    // onto one number quotes what is on the paper, and after the migration
    // that string survives nowhere else. Without this the only number they
    // have finds nothing.
    const bare = bareAccountNumber(query.accountNumber);
    const match =
      bare === query.accountNumber ? { $regex: `^${bare}(?:-[A-Z]{3})?$` } : query.accountNumber;
    // `$and`, because the fuzzy branch below owns the top-level `$or`.
    filter.$and = [{ $or: [{ accountNumber: match }, { issuedNumber: match }] }];
  }
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;

  // Fuzzy: match by customer (typo-tolerant name/phone) or account number prefix.
  if (query.search !== undefined) {
    const customerIds = await fuzzyCustomerIds(query.search);
    const or: Record<string, unknown>[] = [{ customerId: { $in: customerIds } }];
    // Legacy numbers are bare digits; current ones start SU. Both are matched
    // as a prefix, and the cycle-month suffix is dropped first so that a
    // customer quoting SU26090005 still finds SU26090005-SEP.
    const term = bareAccountNumber(query.search.trim()).toUpperCase();
    if (/^(?:\d{2,6}|SU\d{0,8})$/.test(term)) {
      or.push({ accountNumber: { $regex: `^${term}` } });
      // As above: what a pre-migration receipt says.
      or.push({ issuedNumber: { $regex: `^${term}` } });
    }
    filter.$or = or;
  }

  // Applied last, as a top-level customerId condition: Mongo ANDs it with the
  // search $or, so an account-number search cannot reach outside the round.
  const scoped = await withCustomerScope(actor, filter);

  const [accounts, total] = await Promise.all([
    SusuAccountModel.find(scoped)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuAccountModel.countDocuments(scoped),
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
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSusuAccount> {
  const account = await SusuAccountModel.findOne({ _id: id, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);
  return toPublicAccount(account);
}

export async function listAccountDeposits(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListDepositsQuery,
): Promise<{ items: PublicDeposit[]; page: number; limit: number; total: number }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);

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

export interface DepositLeg {
  deposit: PublicDeposit;
  account: PublicSusuAccount;
  /** True when this leg's account was opened by this very payment. */
  carried: boolean;
}

export interface DepositResult {
  /**
   * The leg recorded against the account the request named. Kept at the top
   * level, unchanged, so every existing caller and receipt still reads the
   * same two fields; a carried payment simply has more in `legs`.
   */
  deposit: PublicDeposit;
  account: PublicSusuAccount;
  /** Every leg of this payment, oldest first. Longer than one only on a carry. */
  legs: DepositLeg[];
  /** The whole of what the customer handed over, across all legs. */
  totalAmount: number;
  /** Accounts this payment had to open. Empty on the ordinary path. */
  openedAccounts: PublicSusuAccount[];
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/** The idempotency key a carried leg is written under, derived from the first. */
function carryKey(idempotencyKey: string, index: number): string {
  return `${idempotencyKey}#carry${String(index)}`;
}

/** Assemble the response from the deposit rows, whether fresh or replayed. */
async function buildDepositResult(
  legDocs: SusuDeposit[],
  replayed: boolean,
): Promise<DepositResult> {
  const accounts = await SusuAccountModel.find({
    _id: { $in: legDocs.map((d) => d.accountId) },
  });
  const byId = new Map(accounts.map((a) => [a._id.toHexString(), a]));
  const legs: DepositLeg[] = legDocs.map((d) => {
    const account = byId.get(d.accountId.toHexString());
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return {
      deposit: toPublicDeposit(d),
      account: toPublicAccount(account),
      carried: d.carriedFromDepositId !== undefined,
    };
  });
  const head = legs[0];
  if (!head) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  return {
    deposit: head.deposit,
    account: head.account,
    legs,
    totalAmount: legDocs.reduce((sum, d) => sum + d.amount, 0),
    openedAccounts: legs.filter((l) => l.carried).map((l) => l.account),
    replayed,
  };
}

/** A result with only the leg in hand — the correction paths never carry. */
function singleLegResult(deposit: SusuDeposit, account: SusuAccount): DepositResult {
  const leg: DepositLeg = {
    deposit: toPublicDeposit(deposit),
    account: toPublicAccount(account),
    carried: false,
  };
  return {
    deposit: leg.deposit,
    account: leg.account,
    legs: [leg],
    totalAmount: deposit.amount,
    openedAccounts: [],
    replayed: false,
  };
}

/**
 * Record a collection against a cycle, carrying any overflow into a new one.
 *
 * A susu cycle holds exactly 31 days. A catch-up payment that runs past the
 * end of the cycle it was paid into used to be refused outright, which left
 * the collector holding cash they could not book. It is now split: the days
 * that fit finish the current cycle, and the remainder opens a fresh account
 * for the same customer, at the same immutable daily amount, numbered with the
 * CURRENT month's suffix — the new cycle starts now, whatever the old one was
 * called.
 *
 * The split is pure (`splitAcrossCycles`) and the total is re-checked against
 * the cash before the transaction commits: this is a ledger, and a split that
 * loses a pesewa is worse than a refusal.
 */
export async function recordDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<DepositResult> {
  // Replay of a retried mobile request → return the original, write nothing.
  // A carried payment wrote several rows under derived keys, so all of them
  // have to come back, or a retry would look like it lost money.
  const prior = await SusuDepositModel.find({
    $or: [
      { idempotencyKey },
      { idempotencyKey: { $regex: `^${escapeRegex(idempotencyKey)}#carry` } },
    ],
  }).sort({ createdAt: 1, _id: 1 });
  if (prior.length > 0) {
    if (prior.some((d) => d.deletedAt)) {
      throw new AppError(
        'CONFLICT',
        'The original deposit was moved to the trash — use a new idempotency key',
        409,
      );
    }
    return buildDepositResult(prior, true);
  }

  const accountPre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!accountPre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, accountPre.customerId);
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

  const plan = splitAcrossCycles(accountPre.depositsCount, daysCovered);
  const wouldOpen = carriedAccountCount(plan);
  if (wouldOpen > SUSU_MAX_CARRY_ACCOUNTS) {
    throw new AppError(
      'EXCEEDS_CARRY_LIMIT',
      `That is ${String(daysCovered)} days at once, which would open ` +
        `${String(wouldOpen)} new accounts — check the amount, or record it as ` +
        `separate deposits`,
      422,
      {
        daysCovered,
        remaining: remainingDeposits(accountPre.depositsCount),
        wouldOpen,
        maxCarryAccounts: SUSU_MAX_CARRY_ACCOUNTS,
      },
    );
  }

  // The carried book belongs to the same customer, so it carries the same
  // number — read straight off the parent, which was loaded before the session
  // opened. Pure string work: nothing here touches the counter, so the rule
  // that kept counter writes out of caller transactions is satisfied by
  // construction rather than by care (see counter.model.ts).
  //
  // The cycle month is today's, not the parent account's: the carried cycle
  // begins now. When the parent's month is also today's — the ordinary case —
  // the two books end up with byte-identical numbers, which is exactly what
  // the branch's own passbooks do.
  const month = cycleMonthOf();
  const carriedNumber = withCycleMonth(bareAccountNumber(accountPre.accountNumber), month);

  // One attempt, no replay loop. The loop that used to wrap this existed to
  // re-mint colliding account numbers; the carried book now takes its owner's
  // number, so there is nothing left to collide and nothing to retry.
  let legDocs: SusuDeposit[] = [];
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      legDocs = [];
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

      // Re-derive inside the transaction: a concurrent deposit may have moved
      // the count, which changes where the cycle boundary falls.
      const live = splitAcrossCycles(account.depositsCount, daysCovered);
      if (live.length !== plan.length) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }
      const head = live[0];
      if (!head) throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);

      const headAmount = head.daysCovered * account.dailyAmount;
      // Optimistic concurrency: the counters must not have moved since we read them.
      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: 'active', depositsCount: account.depositsCount },
        {
          $inc: { depositsCount: head.daysCovered, totalDeposited: headAmount },
          ...(head.completesCycle ? { $set: { status: 'completed' } } : {}),
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
            amount: headAmount,
            daysCovered: head.daysCovered,
            seqStart: head.seqStart,
            seqEnd: head.seqEnd,
            channel,
            idempotencyKey,
          },
        ],
        { session },
      );
      const first = created as SusuDeposit;
      legDocs.push(first);

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.record',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: account.totalDeposited,
          amountAfter: account.totalDeposited + headAmount,
          after: {
            daysCovered: head.daysCovered,
            seq: `${String(head.seqStart)}-${String(head.seqEnd)}`,
            ...(live.length > 1 ? { carriedDays: daysCovered - head.daysCovered } : {}),
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );

      // The overflow: one new cycle per remaining chunk, each recorded and
      // linked back to the half it came from.
      let parentAccountId = account._id;
      let parentDeposit = first;
      for (const chunk of live.slice(1)) {
        const chunkAmount = chunk.daysCovered * account.dailyAmount;
        const [openedDoc] = await SusuAccountModel.create(
          [
            {
              accountNumber: carriedNumber,
              customerId: account.customerId,
              // Immutable and inherited: this is the same arrangement
              // continuing, not a renegotiation.
              dailyAmount: account.dailyAmount,
              cycleMonth: month,
              openedById: new Types.ObjectId(actor.sub),
              depositsCount: chunk.daysCovered,
              totalDeposited: chunkAmount,
              status: chunk.completesCycle ? 'completed' : 'active',
              carriedFromAccountId: parentAccountId,
            },
          ],
          { session },
        );
        const opened = openedDoc as SusuAccount;
        const [carriedDoc] = await SusuDepositModel.create(
          [
            {
              accountId: opened._id,
              customerId: account.customerId,
              collectorId: new Types.ObjectId(actor.sub),
              amount: chunkAmount,
              daysCovered: chunk.daysCovered,
              seqStart: chunk.seqStart,
              seqEnd: chunk.seqEnd,
              channel,
              idempotencyKey: carryKey(idempotencyKey, chunk.index),
              carriedFromDepositId: parentDeposit._id,
              carriedFromAccountId: parentAccountId,
            },
          ],
          { session },
        );
        const carried = carriedDoc as SusuDeposit;
        await SusuDepositModel.updateOne(
          { _id: parentDeposit._id },
          { $set: { carriedToDepositId: carried._id, carriedToAccountId: opened._id } },
          { session },
        );
        // Mirror the write onto the in-memory document: it is the one the
        // response is built from, and a caller that cannot see the link
        // cannot offer the customer the other half of their own payment.
        parentDeposit.carriedToDepositId = carried._id;
        parentDeposit.carriedToAccountId = opened._id;
        legDocs.push(carried);

        await audit(
          {
            actorId: actor.sub,
            action: 'susu.account.open',
            entityType: 'susu-account',
            entityId: opened._id,
            after: {
              dailyAmount: account.dailyAmount,
              cycleMonth: month,
              customerId: account.customerId.toHexString(),
              carriedFromAccountId: parentAccountId.toHexString(),
              carriedDays: chunk.daysCovered,
              reason: 'carry-forward',
            },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'susu.deposit.record',
            entityType: 'susu-account',
            entityId: opened._id,
            amountBefore: 0,
            amountAfter: chunkAmount,
            after: {
              daysCovered: chunk.daysCovered,
              seq: `${String(chunk.seqStart)}-${String(chunk.seqEnd)}`,
              carriedFromDepositId: parentDeposit._id.toHexString(),
            },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
        );
        parentAccountId = opened._id;
        parentDeposit = carried;
      }

      // Money conservation, checked before the commit. A split that does not
      // add up to the cash in hand must never reach the database.
      const written = legDocs.reduce((sum, d) => sum + d.amount, 0);
      if (written !== amount) {
        throw new AppError('INTERNAL_ERROR', 'Deposit split did not conserve the amount', 500);
      }
    });
  } finally {
    await session.endSession();
  }

  const result = await buildDepositResult(legDocs, false);
  const opened = result.openedAccounts;

  // Post-commit, fire-and-forget: receipt + live feed. One message however
  // many accounts the payment touched — the gateway allowance is finite, and
  // two texts about one payment read as two payments.
  // The carried book carries the customer's own number, which is the number
  // this very text already quoted — so naming it again would read as "the
  // balance started new acct <the same number>". Say what actually changed
  // instead: a book filled up and the rest went onto the next one.
  const tail =
    opened.length === 0
      ? `Progress: ${String(result.deposit.seqEnd)}/${String(SUSU_CYCLE_DEPOSITS)}. ` +
        `Total saved: ${formatGhs(result.account.totalDeposited)}.`
      : `That cycle is now complete; the balance opened your next ` +
        `${opened.length === 1 ? 'book' : `${String(opened.length)} books`} ` +
        `(${
          opened
            .map((a) => a.cycleMonth ?? '')
            .filter(Boolean)
            .join(', ') || 'this month'
        }).`;
  await enqueueSms({
    to: customer.phone,
    template: 'susu-deposit-receipt',
    message:
      `Yadah: ${formatGhs(result.totalAmount)} received on susu acct ` +
      `${result.account.accountNumber}. ${tail}`,
    relatedEntityType: 'susu-deposit',
    relatedEntityId: new Types.ObjectId(result.deposit.id),
  });
  emitAdminEvent('susu.deposit.recorded', {
    accountId: accountId.toHexString(),
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    amount: result.totalAmount,
    progress: `${String(result.deposit.seqEnd)}/${String(SUSU_CYCLE_DEPOSITS)}`,
    completed: result.account.status === 'completed',
    // `ref` alongside the number: on this feed the number is the parent's too.
    ...(opened.length > 0
      ? {
          carriedTo: opened.map((a) => ({
            id: a.id,
            accountNumber: a.accountNumber,
            ref: a.ref,
          })),
        }
      : {}),
  });
  // Opening an account is normally a counter act; a collector reaching this
  // path has caused one in the field, so the office is told rather than left
  // to find it in the list.
  if (opened.length > 0) {
    notifyOffice({
      type: 'susu.carry-forward',
      title: 'Susu cycle carried forward',
      // Named by ref, not by number. The carried book belongs to the same
      // customer, so its number is the one this sentence has already quoted —
      // "the balance opened SU26090009-SEP" after "on SU26090009-SEP" reads as
      // a duplicate notification and names nothing the clerk can open.
      body:
        `${customer.fullName} paid ${formatGhs(result.totalAmount)} on ` +
        `${result.account.accountNumber}, which filled the cycle. The balance opened ` +
        `their next book (${opened.map((a) => a.ref).join(', ')}).`,
      data: {
        entity: 'susu-account',
        accountId: opened[0]?.id ?? accountId.toHexString(),
        carriedFromAccountId: accountId.toHexString(),
        amount: result.totalAmount,
      },
    });
  }

  return result;
}

// ---------------------------------------------------------------- collect-all

export interface CollectAllResult {
  batchId: string;
  totalAmount: number;
  deposits: PublicDeposit[];
  accounts: PublicSusuAccount[];
  replayed: boolean;
}

export async function collectAll(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<CollectAllResult> {
  await assertCanActOnCustomer(actor, customerId);
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
        // Named by cycle month and reference, not by number: every book here
        // belongs to one customer, so every number is the same string.
        breakdown: active.map((a) => ({
          accountId: a._id.toHexString(),
          ref: accountRef(a._id.toHexString(), a.createdAt),
          ...(a.cycleMonth !== undefined ? { cycleMonth: a.cycleMonth } : {}),
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

  // Labelled by cycle month and daily amount, not by number: every book in
  // this collection belongs to one customer, so every number on it is the
  // same string and a list of them would say nothing.
  const labelById = new Map(
    active.map((a) => [a._id.toHexString(), a.cycleMonth ?? `${formatGhs(a.dailyAmount)}/day`]),
  );
  const lines = created
    .map(
      (d) =>
        `${labelById.get(d.accountId.toHexString()) ?? '??'}: ${formatGhs(d.amount)} ` +
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
  if (susuBalance(pre.totalDeposited, pre.withdrawnAmount) < pre.dailyAmount) {
    throw new AppError(
      'COMMISSION_NOT_COVERED',
      'The balance does not cover the one-day commission — use terminate to refund it',
      422,
      {
        balance: susuBalance(pre.totalDeposited, pre.withdrawnAmount),
        dailyAmount: pre.dailyAmount,
      },
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
      const balance = susuBalance(account.totalDeposited, account.withdrawnAmount);
      if (balance < account.dailyAmount) {
        throw new AppError(
          'COMMISSION_NOT_COVERED',
          'The balance does not cover the one-day commission — use terminate to refund it',
          422,
          { balance, dailyAmount: account.dailyAmount },
        );
      }

      const { commission, payout, flagged } = computeClosure(balance, account.dailyAmount);
      const now = new Date();
      const upd = await SusuAccountModel.updateOne(
        {
          _id: account._id,
          status: account.status,
          totalDeposited: account.totalDeposited,
          withdrawnAmount: account.withdrawnAmount,
        },
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
      //
      // Written even when the payout is zero, which happens whenever someone
      // withdraws the maximum and then closes: one day's amount is reserved
      // for exactly this commission, so `balance === dailyAmount` leaves
      // nothing to hand over. The commission was still charged, and a charge
      // that appears on no row is a charge nobody can audit.
      await SusuPayoutModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            amount: payout,
            destination: 'cash',
            commissionAmount: commission,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey: `close:${account._id.toHexString()}`,
          },
        ],
        { session },
      );

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.account.close',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: balance,
          amountAfter: payout,
          after: {
            commission,
            payout,
            flagged,
            depositsCount: account.depositsCount,
            withdrawnDuringCycle: account.withdrawnAmount,
          },
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

// ---------------------------------------------------------------- partial withdrawal

export interface PartialWithdrawalResult {
  account: PublicSusuAccount;
  amount: number;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/**
 * Take part of a susu balance without closing the account (client decision
 * 2026-08-21, replacing the old rule that any withdrawal closed the account).
 *
 * Three things deliberately do NOT happen here:
 *   - no commission is taken; it is one cycle-day's amount, charged once, at
 *     closure, however many withdrawals happened along the way;
 *   - the cycle is untouched — days already paid stay paid, so depositsCount
 *     and the 31-day target are unchanged;
 *   - the account does not close, whatever the resulting balance.
 *
 * One day's amount is reserved so the closing commission stays collectible.
 */
export async function withdrawPartial(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  requestId?: string,
): Promise<PartialWithdrawalResult> {
  // Replay of a retried request → return the original, write nothing.
  const existing = await SusuPayoutModel.findOne({ idempotencyKey });
  if (existing) {
    const account = await SusuAccountModel.findById(existing.accountId);
    if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
    return { account: toPublicAccount(account), amount: existing.amount, replayed: true };
  }

  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  if (pre.status !== 'active' && pre.status !== 'completed') {
    throw new AppError(
      'ACCOUNT_NOT_OPEN',
      `Account is ${pre.status} — partial withdrawals need an open account`,
      422,
    );
  }

  const preBalance = susuBalance(pre.totalDeposited, pre.withdrawnAmount);
  const available = maxPartialWithdrawal(preBalance, pre.dailyAmount);
  if (amount > available) {
    throw new AppError(
      'EXCEEDS_AVAILABLE',
      available === 0
        ? `Nothing is withdrawable — ${formatGhs(pre.dailyAmount)} stays reserved for the closing commission`
        : `Only ${formatGhs(available)} is withdrawable; ${formatGhs(pre.dailyAmount)} stays reserved for the closing commission`,
      422,
      { available, balance: preBalance, reserved: pre.dailyAmount },
    );
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: { $in: ['active', 'completed'] },
        ...NOT_TRASHED,
      }).session(session);
      if (!account) {
        throw new AppError('ACCOUNT_NOT_OPEN', 'Account is no longer open', 422);
      }

      // Re-derive inside the transaction: a concurrent deposit or withdrawal
      // may have moved the balance since the pre-flight check.
      const balance = susuBalance(account.totalDeposited, account.withdrawnAmount);
      const computation = (() => {
        try {
          return computePartialWithdrawal(balance, account.dailyAmount, amount);
        } catch (err) {
          if (err instanceof RangeError) {
            throw new AppError('EXCEEDS_AVAILABLE', err.message, 422, {
              available: maxPartialWithdrawal(balance, account.dailyAmount),
              balance,
              reserved: account.dailyAmount,
            });
          }
          throw err;
        }
      })();

      const upd = await SusuAccountModel.updateOne(
        {
          _id: account._id,
          status: account.status,
          totalDeposited: account.totalDeposited,
          withdrawnAmount: account.withdrawnAmount,
        },
        { $inc: { withdrawnAmount: amount } },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
      }

      // The cash leaving the drawer — without this row the withdrawal would be
      // invisible in the unified transactions feed.
      await SusuPayoutModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            amount,
            kind: 'partial-withdrawal',
            destination: 'cash',
            // Never charged here: the commission is one cycle-day's amount,
            // taken once, when the account stops. One day stays reserved so
            // it is still collectible then.
            commissionAmount: 0,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey,
          },
        ],
        { session },
      );

      await audit(
        {
          actorId: actor.sub,
          action: 'susu.withdrawal.partial',
          entityType: 'susu-account',
          entityId: account._id,
          amountBefore: balance,
          amountAfter: computation.balanceAfter,
          after: {
            amount,
            reserved: computation.reserved,
            commissionTaken: 0,
            depositsCount: account.depositsCount,
          },
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
    const balanceAfter = susuBalance(after.totalDeposited, after.withdrawnAmount);
    await enqueueSms({
      to: customer.phone,
      template: 'susu-withdrawal',
      message:
        `Yadah: ${formatGhs(amount)} withdrawn from susu acct ${after.accountNumber}. ` +
        `Balance: ${formatGhs(balanceAfter)}. Your account stays open.`,
      relatedEntityType: 'susu-account',
      relatedEntityId: accountId,
    });
  }
  emitAdminEvent('susu.withdrawal.partial', {
    id: accountId.toHexString(),
    customerId: after.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    amount,
    balance: susuBalance(after.totalDeposited, after.withdrawnAmount),
  });
  notifyOffice({
    type: 'susu.withdrawal',
    title: 'Susu partial withdrawal',
    body:
      `${formatGhs(amount)} withdrawn from ${customer?.fullName ?? 'a customer'} ` +
      `(acct ${after.accountNumber}). Account stays open.`,
    data: { entity: 'susu-account', accountId: accountId.toHexString(), amount },
  });

  return { account: toPublicAccount(after), amount, replayed: false };
}

// ---------------------------------------------------------------- terminate

export interface TerminationResult {
  account: PublicSusuAccount;
  refund: number;
}

/**
 * Escape hatch for accounts that cannot be closed normally because their
 * BALANCE does not cover the one-day commission (including empty accounts).
 * Refunds whatever is left, charges nothing.
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
  if (susuBalance(pre.totalDeposited, pre.withdrawnAmount) >= pre.dailyAmount) {
    throw new AppError(
      'CANNOT_TERMINATE',
      'The balance covers the one-day commission — close the account instead',
      422,
      {
        balance: susuBalance(pre.totalDeposited, pre.withdrawnAmount),
        dailyAmount: pre.dailyAmount,
      },
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
      refund = susuBalance(account.totalDeposited, account.withdrawnAmount);

      const upd = await SusuAccountModel.updateOne(
        {
          _id: account._id,
          status: account.status,
          totalDeposited: account.totalDeposited,
          withdrawnAmount: account.withdrawnAmount,
        },
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
              // A termination is the no-commission exit: the balance never
              // covered one day, so the whole of it goes back.
              commissionAmount: 0,
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
          amountBefore: susuBalance(account.totalDeposited, account.withdrawnAmount),
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
            // The commission was charged when the account stopped, on the row
            // that stopped it. An instalment must never charge it again.
            commissionAmount: 0,
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
  // Half of a payment that overflowed into a new cycle. Editing or removing
  // one half alone would leave the other half of the same cash on an account
  // it was never paid into; the carried half has to go first.
  if (deposit.carriedToDepositId) {
    throw new AppError(
      'CANNOT_TRASH',
      'This payment carried into a new account — remove the carried deposit there first',
      422,
      {
        carriedToAccountId: deposit.carriedToAccountId?.toHexString(),
        carriedToDepositId: deposit.carriedToDepositId.toHexString(),
      },
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
      // Removing the carried half releases the half it came from: otherwise
      // the parent stays permanently uncorrectable, pointing at a deposit that
      // is no longer on the books.
      if (deposit.carriedFromDepositId) {
        await SusuDepositModel.updateOne(
          { _id: deposit.carriedFromDepositId },
          { $unset: { carriedToDepositId: '', carriedToAccountId: '' } },
          { session },
        );
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
      // Restoring the carried half re-links the half it came from, so the two
      // are paired again and the parent is protected from a lone correction.
      if (deposit.carriedFromDepositId) {
        await SusuDepositModel.updateOne(
          { _id: deposit.carriedFromDepositId },
          { $set: { carriedToDepositId: deposit._id, carriedToAccountId: deposit.accountId } },
          { session },
        );
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

interface CorrectionPlan {
  newDays: number;
  dayDelta: number;
  newCount: number;
}

/**
 * What correcting this deposit to `amount` would do, or why it cannot be done.
 *
 * One function for both doors: the office correcting a deposit outright, and
 * a teller asking the office to. The proposal is checked here when it is made
 * — so the teller hears "not a whole number of days" at the counter, not the
 * office a day later — and checked here AGAIN when it is applied, because the
 * account may have moved in between and the rules are about the account as it
 * stands, not as it stood.
 */
function planCorrection(
  account: SusuAccount,
  deposit: SusuDeposit,
  amount: number,
): CorrectionPlan {
  assertCorrectable(account, deposit);
  // A Paystack deposit's amount is what Paystack charged, not what somebody
  // typed. There is no data-entry mistake in it to correct.
  if (deposit.channel === 'paystack') {
    throw new AppError(
      'CANNOT_CORRECT',
      'This was paid through Paystack, so the amount is what was charged',
      422,
    );
  }

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
  return { newDays, dayDelta, newCount: account.depositsCount + dayDelta };
}

/**
 * The correction itself, inside the caller's transaction: the account's
 * counters, the deposit's figures, and the audit entry, all committed or
 * rolled back together — and, when the caller is an approval, together with
 * the request's own change of status.
 */
async function applyCorrection(
  session: ClientSession,
  actor: AccessTokenPayload,
  account: SusuAccount,
  deposit: SusuDeposit,
  amount: number,
  plan: CorrectionPlan,
  requestId: string | undefined,
  origin: CorrectionOrigin | undefined,
): Promise<void> {
  const { newDays, dayDelta, newCount } = plan;
  const upd = await SusuAccountModel.updateOne(
    {
      _id: account._id,
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
    { _id: deposit._id, ...NOT_TRASHED, amount: deposit.amount },
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
      entityId: deposit._id,
      amountBefore: deposit.amount,
      amountAfter: amount,
      before: { amount: deposit.amount, daysCovered: deposit.daysCovered },
      after: {
        amount,
        daysCovered: newDays,
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
}

/**
 * Correct the amount of the most recent deposit (data-entry fixes). The
 * office's door; a teller goes through `proposeCorrection` and the office
 * applies it with `approveCorrection`, which runs this same correction.
 */
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
  const plan = planCorrection(account, deposit, amount);
  if (plan.dayDelta === 0 && amount === deposit.amount) return singleLegResult(deposit, account);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applyCorrection(session, actor, account, deposit, amount, plan, requestId, undefined);
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
  return singleLegResult(afterDeposit, afterAccount);
}

// ---------------------------------------------------------------- corrections

/**
 * A deposit correction as the corrections module runs it: outright for the
 * office, or after a teller asked and the office approved. The rules are the
 * ones above; this only packages them behind the shared contract (see
 * lib/corrections.ts).
 */
export const prepareDepositCorrection: CorrectionPreparer = async (accountId, depositId) => {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);

  return {
    kind: 'susu-deposit',
    targetId: accountId,
    txnId: depositId,
    customerId: deposit.customerId,
    amount: deposit.amount,
    units: deposit.daysCovered,
    plan: (amount) => ({ units: planCorrection(account, deposit, amount).newDays }),
    apply: (session, actor, amount, requestId, origin) =>
      applyCorrection(
        session,
        actor,
        account,
        deposit,
        amount,
        planCorrection(account, deposit, amount),
        requestId,
        origin,
      ),
    result: async () => {
      const [afterDeposit, afterAccount] = await Promise.all([
        SusuDepositModel.findById(depositId),
        SusuAccountModel.findById(accountId),
      ]);
      if (!afterDeposit || !afterAccount) {
        throw new AppError('NOT_FOUND', 'Deposit not found', 404);
      }
      return { target: toPublicAccount(afterAccount), txn: toPublicDeposit(afterDeposit) };
    },
  };
};

// ---------------------------------------------------------------- receipts

export interface ReceiptFile {
  buffer: Buffer;
  filename: string;
}

/**
 * The account's balance at a point in time, rebuilt from the ledger rather
 * than read off the account. A receipt reprinted months later must still show
 * the balance as it stood that day, not today's.
 */
async function susuBalanceAsOf(accountId: Types.ObjectId, at: Date): Promise<number> {
  const [deposited, withdrawn] = await Promise.all([
    SusuDepositModel.aggregate<{ total: number }>([
      { $match: { accountId, createdAt: { $lte: at }, ...NOT_TRASHED } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    SusuPayoutModel.aggregate<{ total: number }>([
      { $match: { accountId, kind: 'partial-withdrawal', createdAt: { $lte: at } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
  ]);
  return (deposited[0]?.total ?? 0) - (withdrawn[0]?.total ?? 0);
}

async function staffName(userId: Types.ObjectId): Promise<string> {
  const user = await UserModel.findById(userId).select('name');
  return user?.name ?? 'Yadah staff';
}

/** Loads the account + customer for a receipt, enforcing the collector lock. */
async function receiptContext(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
): Promise<{ account: SusuAccount; customer: Customer | null }> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);
  const customer = await CustomerModel.findById(account.customerId);
  return { account, customer };
}

export async function depositReceipt(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
): Promise<ReceiptFile> {
  const { account, customer } = await receiptContext(actor, accountId);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);

  const lines: ReceiptLine[] = [
    { label: 'Daily amount', value: formatGhs(account.dailyAmount) },
    {
      label: 'Days covered',
      value:
        deposit.daysCovered === 1
          ? `1 day (day ${String(deposit.seqEnd)})`
          : `${String(deposit.daysCovered)} days (days ${String(deposit.seqStart)}–${String(deposit.seqEnd)})`,
    },
    {
      label: 'Cycle progress',
      value: `${String(deposit.seqEnd)} of ${String(SUSU_CYCLE_DEPOSITS)} days paid`,
    },
    {
      label: 'Balance after',
      value: formatGhs(await susuBalanceAsOf(accountId, deposit.createdAt)),
      emphasis: true,
    },
    { label: 'Payment method', value: deposit.channel },
  ];

  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber('SD', deposit._id),
    kind: 'deposit',
    title: 'Susu Deposit',
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: account.accountNumber,
    amount: deposit.amount,
    lines,
    recordedByName: await staffName(deposit.collectorId),
    at: deposit.createdAt,
    reference: deposit._id.toHexString(),
  });
  return { buffer, filename: `susu-deposit-${receiptNumber('SD', deposit._id)}.pdf` };
}

/**
 * Covers both kinds of money leaving a susu account: a partial withdrawal
 * that leaves the account open, and the payout that ends it.
 */
export async function withdrawalReceipt(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  payoutId: Types.ObjectId,
): Promise<ReceiptFile> {
  const { account, customer } = await receiptContext(actor, accountId);
  const payout = await SusuPayoutModel.findOne({ _id: payoutId, accountId });
  if (!payout) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);

  const partial = payout.kind === 'partial-withdrawal';
  const lines: ReceiptLine[] = [
    { label: 'Daily amount', value: formatGhs(account.dailyAmount) },
    {
      label: 'Cycle progress',
      value: `${String(account.depositsCount)} of ${String(SUSU_CYCLE_DEPOSITS)} days paid`,
    },
  ];

  if (partial) {
    lines.push(
      {
        label: 'Balance after',
        value: formatGhs(await susuBalanceAsOf(accountId, payout.createdAt)),
        emphasis: true,
      },
      { label: 'Commission taken', value: 'None — charged once when the account closes' },
      { label: 'Account status', value: 'Still open' },
    );
  } else {
    if (account.commissionAmount !== undefined) {
      lines.push({ label: 'Commission (1 day)', value: formatGhs(account.commissionAmount) });
    }
    lines.push(
      { label: 'Destination', value: payout.destination },
      { label: 'Account status', value: account.status },
    );
    if (account.payoutRemaining > 0) {
      lines.push({
        label: 'Still awaiting payout',
        value: formatGhs(account.payoutRemaining),
        emphasis: true,
      });
    }
  }

  const prefix = partial ? 'SW' : 'SP';
  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber(prefix, payout._id),
    kind: 'withdrawal',
    title: partial ? 'Susu Partial Withdrawal' : 'Susu Payout',
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: account.accountNumber,
    amount: payout.amount,
    lines,
    recordedByName: await staffName(payout.recordedById),
    at: payout.createdAt,
    reference: payout._id.toHexString(),
  });
  return { buffer, filename: `susu-withdrawal-${receiptNumber(prefix, payout._id)}.pdf` };
}
