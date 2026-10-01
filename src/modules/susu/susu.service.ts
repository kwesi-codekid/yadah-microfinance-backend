import mongoose, { Types, type ClientSession } from 'mongoose';
import { nextAccountNumber } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { resolveOccurredAt } from '../../lib/backdating.js';
import type { CorrectionOrigin, CorrectionPreparer } from '../../lib/corrections.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
import {
  CustomerModel,
  SusuAccountModel,
  SusuCycleModel,
  SusuDepositModel,
  SusuPayoutModel,
  SusuPlanModel,
  UserModel,
  type Customer,
  type SusuAccount,
  type SusuCycle,
  type SusuDeposit,
  type SusuPlan,
} from '../../models/index.js';
import type { SusuDepositLine } from '../../models/susu-deposit.model.js';
import type { SusuPayout, SusuPayoutLine } from '../../models/susu-payout.model.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
import {
  SUSU_CYCLE_PAYMENTS,
  allocateDeposit,
  canChangeAmount,
  computeClose,
  computeStopPlan,
  computeWithdrawal,
  allocateWithdrawal,
  defaultSplit,
  isMidCycle,
  lockedAmount,
  maxWithdrawal,
  type DepositAllocation,
  type PlanSplit,
  type PlanState,
} from '../../domain/susu-plans.js';
import { assertCanActOnCustomer, withCustomerScope } from '../../lib/customer-scope.js';
import { notifyOffice } from '../../lib/notifications.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { NOT_TRASHED, requireDeletedAt, type Channel } from '../../models/shared.js';
import type {
  ListAccountsQuery,
  ListCyclesQuery,
  ListPayoutsQuery,
  ListDepositsQuery,
  ListTrashQuery,
  SummaryQuery,
} from './susu.schemas.js';

// ---------------------------------------------------------------- shapes

export interface PublicSusuPlan {
  id: string;
  accountId: string;
  dailyAmount: number;
  /** Payments made in the cycle in progress, 0..30. */
  paidInCycle: number;
  cycleTarget: number;
  /** The cycle in progress (or, between cycles, the one the next deposit starts). */
  cycleNumber: number;
  cyclesCompleted: number;
  status: 'active' | 'stopped';
  /** One payment's amount while a cycle is in progress; 0 between cycles or stopped. */
  locked: number;
  /** True between cycles: the amount may be changed before the next deposit. */
  amountChangeable: boolean;
  startedAt: Date;
  stoppedAt?: Date;
  stopCommission?: number;
  /**
   * What the plan holds, pesewas: ended cycles net of commission, plus the
   * cycle in progress, less withdrawals beyond the days they cost. Only on the
   * account detail — listings do not pay for the aggregate. 0 once closed.
   */
  balance?: number;
  /** Σ withdrawals taken off this plan, pesewas. Detail only, like `balance`. */
  withdrawn?: number;
}

export interface PublicSusuAccount {
  id: string;
  /** The customer's susu number, one per customer for life. */
  accountNumber: string;
  customerId: string;
  /** Present on list responses for display; joined from the customer. */
  customerName?: string;
  balance: number;
  /** Σ one payment per plan mid-cycle — the part of the balance nothing may take. */
  locked: number;
  /** balance − locked, floored at 0. */
  availableToWithdraw: number;
  /** Σ daily amounts of the active plans — what one day's round collects. */
  dailyTotal: number;
  status: 'active' | 'closed';
  plans: PublicSusuPlan[];
  openedAt: Date;
  closedAt?: Date;
  closeCommission?: number;
  closePayout?: number;
}

export function toPublicPlan(p: SusuPlan, money?: PlanMoney): PublicSusuPlan {
  const mid = p.status === 'active' && p.paidInCycle > 0;
  return {
    ...(money ? { balance: money.balance, withdrawn: money.withdrawn } : {}),
    id: p._id.toHexString(),
    accountId: p.accountId.toHexString(),
    dailyAmount: p.dailyAmount,
    paidInCycle: p.paidInCycle,
    cycleTarget: SUSU_CYCLE_PAYMENTS,
    cycleNumber: p.cyclesCompleted + 1,
    cyclesCompleted: p.cyclesCompleted,
    status: p.status,
    locked: mid ? p.dailyAmount : 0,
    amountChangeable: p.status === 'active' && p.paidInCycle === 0,
    startedAt: p.createdAt,
    ...(p.stoppedAt !== undefined ? { stoppedAt: p.stoppedAt } : {}),
    ...(p.stopCommission !== undefined ? { stopCommission: p.stopCommission } : {}),
  };
}

/** The rule-relevant slice of a plan, keyed the way the domain wants. */
function stateOf(p: SusuPlan): PlanState {
  return {
    planId: p._id.toHexString(),
    dailyAmount: p.dailyAmount,
    paidInCycle: p.paidInCycle,
    cyclesCompleted: p.cyclesCompleted,
    status: p.status,
  };
}

function planStates(plans: readonly SusuPlan[]): PlanState[] {
  return plans.map(stateOf);
}

export function toPublicAccount(
  a: SusuAccount,
  plans: readonly SusuPlan[],
  /** Per plan id, what it holds and what left it. Given on the detail; listings leave it out. */
  money?: ReadonlyMap<string, PlanMoney>,
): PublicSusuAccount {
  const states = planStates(plans);
  const locked = a.status === 'active' ? lockedAmount(states) : 0;
  return {
    id: a._id.toHexString(),
    accountNumber: a.accountNumber,
    customerId: a.customerId.toHexString(),
    balance: a.balance,
    locked,
    availableToWithdraw: a.status === 'active' ? maxWithdrawal(a.balance, states) : 0,
    dailyTotal: plans.reduce((sum, p) => (p.status === 'active' ? sum + p.dailyAmount : sum), 0),
    status: a.status,
    // Active plans first, then the stopped ones, each group oldest first —
    // the order the account page lists them in.
    plans: [...plans]
      .sort(
        (x, y) =>
          Number(x.status === 'stopped') - Number(y.status === 'stopped') ||
          x.createdAt.getTime() - y.createdAt.getTime(),
      )
      .map((p) => {
        if (!money) return toPublicPlan(p);
        const m = money.get(p._id.toHexString()) ?? { balance: 0, withdrawn: 0 };
        // A closed account paid everything out; its plans hold nothing now.
        return toPublicPlan(p, a.status === 'active' ? m : { ...m, balance: 0 });
      }),
    openedAt: a.createdAt,
    ...(a.closedAt !== undefined ? { closedAt: a.closedAt } : {}),
    ...(a.closeCommission !== undefined ? { closeCommission: a.closeCommission } : {}),
    ...(a.closePayout !== undefined ? { closePayout: a.closePayout } : {}),
  };
}

/** Flat spreadsheet row for the accounts listing export (csv/xlsx). */
export function toSusuAccountExportRow(item: PublicSusuAccount): Record<string, unknown> {
  return {
    id: item.id,
    accountNumber: item.accountNumber,
    customerName: item.customerName ?? '',
    customerId: item.customerId,
    balance: item.balance,
    locked: item.locked,
    availableToWithdraw: item.availableToWithdraw,
    dailyTotal: item.dailyTotal,
    plans: item.plans
      .filter((p) => p.status === 'active')
      .map(
        (p) => `${formatGhs(p.dailyAmount)}/day ${String(p.paidInCycle)}/${String(p.cycleTarget)}`,
      )
      .join('; '),
    status: item.status,
    openedAt: item.openedAt,
    closedAt: item.closedAt ?? null,
  };
}

export interface PublicDepositLine {
  planId: string;
  dailyAmount: number;
  cycleNumber: number;
  payments: number;
  seqStart: number;
  seqEnd: number;
  amount: number;
  commissionAmount: number;
  /** True when this line landed the 31st payment. */
  completesCycle: boolean;
}

export interface PublicDeposit {
  id: string;
  accountId: string;
  customerId: string;
  collectorId: string;
  amount: number;
  /** Σ lines.payments. */
  payments: number;
  lines: PublicDepositLine[];
  leftover: number;
  commissionAmount: number;
  channel: string;
  createdAt: Date;
}

function toPublicLine(l: SusuDepositLine): PublicDepositLine {
  return {
    planId: l.planId.toHexString(),
    dailyAmount: l.dailyAmount,
    cycleNumber: l.cycleNumber,
    payments: l.payments,
    seqStart: l.seqStart,
    seqEnd: l.seqEnd,
    amount: l.amount,
    commissionAmount: l.commissionAmount,
    completesCycle: l.seqEnd === SUSU_CYCLE_PAYMENTS,
  };
}

export function toPublicDeposit(d: SusuDeposit): PublicDeposit {
  return {
    id: d._id.toHexString(),
    accountId: d.accountId.toHexString(),
    customerId: d.customerId.toHexString(),
    collectorId: d.collectorId.toHexString(),
    amount: d.amount,
    payments: d.lines.reduce((sum, l) => sum + l.payments, 0),
    lines: d.lines.map(toPublicLine),
    leftover: d.leftover,
    commissionAmount: d.commissionAmount,
    channel: d.channel,
    createdAt: d.createdAt,
  };
}

/** Flat spreadsheet row for the deposit-history (statement) export (csv/xlsx). */
export function toSusuDepositExportRow(item: PublicDeposit): Record<string, unknown> {
  return {
    id: item.id,
    amount: item.amount,
    payments: item.payments,
    lines: item.lines
      .map(
        (l) =>
          `${formatGhs(l.dailyAmount)}/day cycle ${String(l.cycleNumber)}: ` +
          `${String(l.seqStart)}–${String(l.seqEnd)}`,
      )
      .join('; '),
    leftover: item.leftover,
    commissionAmount: item.commissionAmount,
    channel: item.channel,
    collectorId: item.collectorId,
    createdAt: item.createdAt,
  };
}

export interface PublicCycle {
  id: string;
  planId: string;
  accountId: string;
  cycleNumber: number;
  dailyAmount: number;
  payments: number;
  commissionAmount: number;
  endReason: 'completed' | 'plan-stopped' | 'account-closed';
  endedAt: Date;
}

export function toPublicCycle(c: SusuCycle): PublicCycle {
  return {
    id: c._id.toHexString(),
    planId: c.planId.toHexString(),
    accountId: c.accountId.toHexString(),
    cycleNumber: c.cycleNumber,
    dailyAmount: c.dailyAmount,
    payments: c.payments,
    commissionAmount: c.commissionAmount,
    endReason: c.endReason,
    endedAt: c.endedAt,
  };
}

// ---------------------------------------------------------------- helpers

async function loadCustomer(customerId: Types.ObjectId): Promise<Customer> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return customer;
}

async function loadPlans(accountId: Types.ObjectId, session?: ClientSession): Promise<SusuPlan[]> {
  const q = SusuPlanModel.find({ accountId }).sort({ createdAt: 1, _id: 1 });
  return session ? q.session(session) : q;
}

/** What a plan holds and what has been taken off it, pesewas. */
export interface PlanMoney {
  balance: number;
  withdrawn: number;
}

/**
 * Each plan's share of the account's balance, keyed by plan id: its ended
 * cycles net of the commission they took, plus the cycle in progress, less
 * the withdrawals taken off it beyond the days they cost (those days are
 * already gone from `paidInCycle`). Two aggregates, so it is read on the
 * detail and inside a withdrawal, never on a listing.
 */
export async function planMoney(
  accountId: Types.ObjectId,
  plans: readonly SusuPlan[],
  session?: ClientSession,
): Promise<Map<string, PlanMoney>> {
  const cyclesQ = SusuCycleModel.aggregate<{ _id: Types.ObjectId; net: number }>([
    { $match: { accountId } },
    {
      $group: {
        _id: '$planId',
        net: {
          $sum: { $subtract: [{ $multiply: ['$payments', '$dailyAmount'] }, '$commissionAmount'] },
        },
      },
    },
  ]);
  const payoutsQ = SusuPayoutModel.aggregate<{
    _id: Types.ObjectId;
    withdrawn: number;
    beyond: number;
  }>([
    { $match: { accountId, kind: { $in: ['withdrawal', 'payout'] }, lines: { $exists: true } } },
    { $unwind: '$lines' },
    {
      $group: {
        _id: '$lines.planId',
        withdrawn: { $sum: '$lines.amount' },
        beyond: {
          $sum: {
            $subtract: [
              '$lines.amount',
              { $multiply: ['$lines.paymentsRemoved', '$lines.dailyAmount'] },
            ],
          },
        },
      },
    },
  ]);
  if (session) {
    cyclesQ.session(session);
    payoutsQ.session(session);
  }
  const [cycles, payouts] = await Promise.all([cyclesQ, payoutsQ]);
  const net = new Map(cycles.map((c) => [c._id.toHexString(), c.net]));
  const out = new Map(payouts.map((p) => [p._id.toHexString(), p]));
  return new Map(
    plans.map((p) => {
      const id = p._id.toHexString();
      const taken = out.get(id);
      return [
        id,
        {
          balance: (net.get(id) ?? 0) + p.paidInCycle * p.dailyAmount - (taken?.beyond ?? 0),
          withdrawn: taken?.withdrawn ?? 0,
        },
      ];
    }),
  );
}

/** Running plans first, then stopped; each group oldest first — the order the money walks them. */
export function orderPlans(plans: readonly SusuPlan[]): SusuPlan[] {
  return [...plans].sort(
    (x, y) =>
      Number(x.status === 'stopped') - Number(y.status === 'stopped') ||
      x.createdAt.getTime() - y.createdAt.getTime(),
  );
}

/** The account plus its plans, as the API shows them. Reads fresh. */
async function publicAccount(accountId: Types.ObjectId): Promise<PublicSusuAccount> {
  const [account, plans] = await Promise.all([
    SusuAccountModel.findById(accountId),
    loadPlans(accountId),
  ]);
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  return toPublicAccount(account, plans, await planMoney(accountId, plans));
}

/** Loads a live account and enforces the collector lock. */
async function liveAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
): Promise<SusuAccount> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  await assertCanActOnCustomer(actor, account.customerId);
  return account;
}

function conflict(): AppError {
  return new AppError('CONFLICT', 'Account was updated concurrently — retry', 409);
}

/** Domain refusals are RangeErrors with a message fit for staff. */
function asApiError(err: unknown, code: string, details?: Record<string, unknown>): never {
  if (err instanceof RangeError) {
    throw new AppError(code, err.message, 422, details);
  }
  throw err;
}

/**
 * Move a plan's counters, guarded on the values they were read at so two
 * writers cannot both credit the same positions.
 */
async function movePlan(
  session: ClientSession,
  plan: SusuPlan,
  after: Pick<SusuPlan, 'paidInCycle' | 'cyclesCompleted'>,
): Promise<void> {
  const upd = await SusuPlanModel.updateOne(
    {
      _id: plan._id,
      status: 'active',
      paidInCycle: plan.paidInCycle,
      cyclesCompleted: plan.cyclesCompleted,
    },
    { $set: after },
    { session },
  );
  if (upd.modifiedCount !== 1 && upd.matchedCount !== 1) throw conflict();
}

/** Move the balance, guarded on the value it was read at. */
async function moveBalance(
  session: ClientSession,
  account: SusuAccount,
  delta: number,
): Promise<void> {
  if (delta === 0) return;
  const upd = await SusuAccountModel.updateOne(
    { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
    { $inc: { balance: delta } },
    { session },
  );
  if (upd.modifiedCount !== 1) throw conflict();
}

// ---------------------------------------------------------------- accounts

/**
 * The customer's susu number — one per customer, for life. A number already
 * claimed is returned as-is; otherwise one is minted from the monthly
 * sequence and claimed atomically (`{ susuNumber: null }` matches a missing
 * field too, so exactly one of two simultaneous openings can set it).
 *
 * MUST NOT be called inside a mongoose session: it writes the counter, which
 * deliberately stays out of caller transactions (see counter.model.ts).
 */
async function susuNumberFor(customerId: Types.ObjectId): Promise<string> {
  const held = await CustomerModel.findById(customerId, { susuNumber: 1 });
  if (held?.susuNumber) return held.susuNumber;

  const candidate = await nextAccountNumber('SU');
  const claimed = await CustomerModel.findOneAndUpdate(
    { _id: customerId, susuNumber: null },
    { $set: { susuNumber: candidate } },
    { returnDocument: 'after' },
  );
  if (claimed?.susuNumber) return claimed.susuNumber;

  const winner = await CustomerModel.findById(customerId, { susuNumber: 1 });
  if (!winner?.susuNumber) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  return winner.susuNumber;
}

export interface OpenAccountResult {
  account: PublicSusuAccount;
  /** True when a closed account was brought back rather than a new one made. */
  reopened: boolean;
}

/**
 * Open the customer's susu account with its first plan.
 *
 * There is one per customer. Opening for a customer who already has one open
 * is refused with the account to use; for one whose account was closed, the
 * same account is reopened — same number, same history — with the new plan.
 */
export async function openAccount(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  dailyAmount: number,
  requestId?: string,
): Promise<OpenAccountResult> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }

  const existing = await SusuAccountModel.findOne({ customerId, ...NOT_TRASHED });
  if (existing?.status === 'active') {
    throw new AppError(
      'ALREADY_OPEN',
      'This customer already has a susu account — add a plan to it instead',
      409,
      { accountId: existing._id.toHexString(), accountNumber: existing.accountNumber },
    );
  }

  // Outside the session, by the counter's rule.
  const accountNumber = existing?.accountNumber ?? (await susuNumberFor(customerId));
  const actorId = new Types.ObjectId(actor.sub);
  let accountId!: Types.ObjectId;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (existing) {
        const upd = await SusuAccountModel.updateOne(
          { _id: existing._id, status: 'closed', ...NOT_TRASHED },
          {
            $set: { status: 'active', openedById: actorId },
            $unset: { closedAt: '', closedById: '', closeCommission: '', closePayout: '' },
          },
          { session },
        );
        if (upd.modifiedCount !== 1) throw conflict();
        accountId = existing._id;
      } else {
        try {
          const [created] = await SusuAccountModel.create(
            [{ accountNumber, customerId, openedById: actorId }],
            { session },
          );
          accountId = (created as SusuAccount)._id;
        } catch (err) {
          // The partial unique index on customerId: somebody opened it first.
          if ((err as { code?: number }).code === 11000) {
            throw new AppError('ALREADY_OPEN', 'This customer already has a susu account', 409);
          }
          throw err;
        }
      }
      const [plan] = await SusuPlanModel.create(
        [{ accountId, customerId, dailyAmount, startedById: actorId }],
        { session },
      );
      await audit(
        {
          actorId: actor.sub,
          action: existing ? 'susu.account.reopen' : 'susu.account.open',
          entityType: 'susu-account',
          entityId: accountId,
          after: { accountNumber, customerId: customerId.toHexString(), dailyAmount },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.plan.add',
          entityType: 'susu-plan',
          entityId: (plan as SusuPlan)._id,
          after: { accountId: accountId.toHexString(), dailyAmount },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const account = await publicAccount(accountId);
  emitAdminEvent('susu.account.opened', {
    id: account.id,
    accountNumber,
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    dailyAmount,
    reopened: existing !== null,
  });
  return { account, reopened: existing !== null };
}

export interface AccountList {
  items: PublicSusuAccount[];
  page: number;
  limit: number;
  total: number;
}

/** One page-sized join for display names. */
async function customerNamesById(ids: Types.ObjectId[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids.map((id) => id.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  return new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
}

/** Plans for a page of accounts, grouped by account. */
async function plansByAccount(accounts: readonly SusuAccount[]): Promise<Map<string, SusuPlan[]>> {
  const plans = await SusuPlanModel.find({ accountId: { $in: accounts.map((a) => a._id) } }).sort({
    createdAt: 1,
    _id: 1,
  });
  const out = new Map<string, SusuPlan[]>();
  for (const p of plans) {
    const key = p.accountId.toHexString();
    const list = out.get(key);
    if (list) list.push(p);
    else out.set(key, [p]);
  }
  return out;
}

async function withNamesAndPlans(accounts: SusuAccount[]): Promise<PublicSusuAccount[]> {
  const [names, plans] = await Promise.all([
    customerNamesById(accounts.map((a) => a.customerId)),
    plansByAccount(accounts),
  ]);
  return accounts.map((a) => ({
    ...toPublicAccount(a, plans.get(a._id.toHexString()) ?? []),
    customerName: names.get(a.customerId.toHexString()) ?? '',
  }));
}

export async function listAccounts(
  actor: AccessTokenPayload,
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
    const term = query.search.trim().toUpperCase();
    if (/^(?:\d{2,6}|SU\d{0,8})$/.test(term)) {
      or.push({ accountNumber: { $regex: `^${term}` } });
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
  return { items: await withNamesAndPlans(accounts), page: query.page, limit: query.limit, total };
}

export async function getAccount(
  actor: AccessTokenPayload,
  id: Types.ObjectId,
): Promise<PublicSusuAccount> {
  const account = await liveAccount(actor, id);
  const plans = await loadPlans(account._id);
  return toPublicAccount(account, plans, await planMoney(account._id, plans));
}

/** The customer's live account, if they have one. Used by the modules that move money in and out. */
export async function findCustomerAccount(
  customerId: Types.ObjectId,
): Promise<PublicSusuAccount | null> {
  const account = await SusuAccountModel.findOne({ customerId, ...NOT_TRASHED });
  if (!account) return null;
  return toPublicAccount(account, await loadPlans(account._id));
}

export async function listAccountDeposits(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListDepositsQuery,
): Promise<{ items: PublicDeposit[]; page: number; limit: number; total: number }> {
  await liveAccount(actor, accountId);
  const filter: Record<string, unknown> = { accountId, ...NOT_TRASHED };
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;
  const [deposits, total] = await Promise.all([
    SusuDepositModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuDepositModel.countDocuments(filter),
  ]);
  return { items: deposits.map(toPublicDeposit), page: query.page, limit: query.limit, total };
}

/** Ended cycles, newest first — the statement's history and the commission trail. */
export async function listAccountCycles(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListCyclesQuery,
): Promise<{ items: PublicCycle[]; page: number; limit: number; total: number }> {
  await liveAccount(actor, accountId);
  const filter: Record<string, unknown> = { accountId };
  if (query.planId) filter.planId = query.planId;
  const [cycles, total] = await Promise.all([
    SusuCycleModel.find(filter)
      .sort({ endedAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuCycleModel.countDocuments(filter),
  ]);
  return { items: cycles.map(toPublicCycle), page: query.page, limit: query.limit, total };
}

export interface PublicPayout {
  id: string;
  accountId: string;
  amount: number;
  /** 'withdrawal' leaves the account open; 'payout' is the closing disbursement. */
  kind: 'payout' | 'withdrawal';
  destination: 'cash' | 'savings' | 'loan' | 'hire-purchase';
  commissionAmount: number;
  /** How the money was spread over the plans; absent on closing payouts and pre-plan rows. */
  lines?: PublicWithdrawalLine[];
  recordedById: string;
  createdAt: Date;
}

export function toPublicPayout(p: SusuPayout): PublicPayout {
  return {
    id: p._id.toHexString(),
    accountId: p.accountId.toHexString(),
    amount: p.amount,
    kind: p.kind,
    destination: p.destination,
    commissionAmount: p.commissionAmount ?? 0,
    ...(p.lines ? { lines: p.lines.map(toPublicWithdrawalLine) } : {}),
    recordedById: p.recordedById.toHexString(),
    createdAt: p.createdAt,
  };
}

/** Money out, newest first — the other half of the statement. */
export async function listAccountPayouts(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  query: ListPayoutsQuery,
): Promise<{ items: PublicPayout[]; page: number; limit: number; total: number }> {
  await liveAccount(actor, accountId);
  const filter: Record<string, unknown> = { accountId };
  if (query.planId) filter['lines.planId'] = query.planId;
  const [payouts, total] = await Promise.all([
    SusuPayoutModel.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    SusuPayoutModel.countDocuments(filter),
  ]);
  return { items: payouts.map(toPublicPayout), page: query.page, limit: query.limit, total };
}

// ---------------------------------------------------------------- plans

export interface PlanResult {
  account: PublicSusuAccount;
  plan: PublicSusuPlan;
}

/** Start another daily amount on the account. Its cycle begins with its first deposit. */
export async function addPlan(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  dailyAmount: number,
  requestId?: string,
): Promise<PlanResult> {
  const account = await liveAccount(actor, accountId);
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'The account is closed — reopen it first', 422);
  }
  const customer = await loadCustomer(account.customerId);

  const plan = await SusuPlanModel.create({
    accountId,
    customerId: account.customerId,
    dailyAmount,
    startedById: new Types.ObjectId(actor.sub),
  });
  await audit({
    actorId: actor.sub,
    action: 'susu.plan.add',
    entityType: 'susu-plan',
    entityId: plan._id,
    after: { accountId: accountId.toHexString(), dailyAmount },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.plan.added', {
    accountId: accountId.toHexString(),
    planId: plan._id.toHexString(),
    customerId: account.customerId.toHexString(),
    customerName: customer.fullName,
    dailyAmount,
  });
  return { account: await publicAccount(accountId), plan: toPublicPlan(plan) };
}

/**
 * Change a plan's daily amount. Only between cycles: the next cycle, and its
 * commission, run at the new amount. Mid-cycle the request is refused — stop
 * the plan (charging its one payment) and start a new one instead.
 */
export async function changePlanAmount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  planId: Types.ObjectId,
  dailyAmount: number,
  requestId?: string,
): Promise<PlanResult> {
  const account = await liveAccount(actor, accountId);
  const plan = await SusuPlanModel.findOne({ _id: planId, accountId });
  if (!plan) throw new AppError('NOT_FOUND', 'Plan not found', 404);
  if (account.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'The account is closed', 422);
  }
  if (!canChangeAmount(stateOf(plan))) {
    throw new AppError(
      plan.status === 'stopped' ? 'PLAN_STOPPED' : 'PLAN_MID_CYCLE',
      plan.status === 'stopped'
        ? 'This plan has been stopped — start a new one at the new amount'
        : `This plan is ${String(plan.paidInCycle)} of ${String(SUSU_CYCLE_PAYMENTS)} into a cycle — ` +
            'wait for it to complete, or stop the plan and start a new one',
      422,
      { paidInCycle: plan.paidInCycle },
    );
  }
  if (dailyAmount === plan.dailyAmount) {
    return { account: await publicAccount(accountId), plan: toPublicPlan(plan) };
  }

  const upd = await SusuPlanModel.updateOne(
    { _id: planId, status: 'active', paidInCycle: 0, dailyAmount: plan.dailyAmount },
    { $set: { dailyAmount } },
  );
  if (upd.modifiedCount !== 1) throw conflict();
  await audit({
    actorId: actor.sub,
    action: 'susu.plan.change-amount',
    entityType: 'susu-plan',
    entityId: planId,
    amountBefore: plan.dailyAmount,
    amountAfter: dailyAmount,
    before: { dailyAmount: plan.dailyAmount },
    after: { dailyAmount },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('susu.plan.changed', {
    accountId: accountId.toHexString(),
    planId: planId.toHexString(),
    dailyAmountBefore: plan.dailyAmount,
    dailyAmountAfter: dailyAmount,
  });
  const after = await SusuPlanModel.findById(planId);
  if (!after) throw new AppError('NOT_FOUND', 'Plan not found', 404);
  return { account: await publicAccount(accountId), plan: toPublicPlan(after) };
}

export interface StopPlanResult extends PlanResult {
  /** One payment's amount when the plan was mid-cycle; 0 between cycles. */
  commission: number;
}

/** Inside a transaction: stop one plan, charge and record its unfinished cycle. */
async function stopPlanWithin(
  session: ClientSession,
  actor: AccessTokenPayload,
  account: SusuAccount,
  plan: SusuPlan,
  endReason: 'plan-stopped' | 'account-closed',
  requestId: string | undefined,
): Promise<number> {
  const stop = (() => {
    try {
      return computeStopPlan(stateOf(plan));
    } catch (err) {
      return asApiError(err, 'PLAN_STOPPED');
    }
  })();
  const now = new Date();
  const upd = await SusuPlanModel.updateOne(
    { _id: plan._id, status: 'active', paidInCycle: plan.paidInCycle },
    {
      $set: {
        status: 'stopped',
        stoppedAt: now,
        stoppedById: new Types.ObjectId(actor.sub),
        stopCommission: stop.commission,
      },
    },
    { session },
  );
  if (upd.modifiedCount !== 1) throw conflict();
  if (stop.endedCycle) {
    await SusuCycleModel.create(
      [
        {
          planId: plan._id,
          accountId: account._id,
          customerId: account.customerId,
          cycleNumber: stop.endedCycle.cycleNumber,
          dailyAmount: plan.dailyAmount,
          payments: stop.endedCycle.payments,
          commissionAmount: stop.commission,
          endReason,
          endedAt: now,
          endedById: new Types.ObjectId(actor.sub),
        },
      ],
      { session },
    );
  }
  await audit(
    {
      actorId: actor.sub,
      action: 'susu.plan.stop',
      entityType: 'susu-plan',
      entityId: plan._id,
      amountBefore: account.balance,
      amountAfter: account.balance - stop.commission,
      after: {
        dailyAmount: plan.dailyAmount,
        paidInCycle: plan.paidInCycle,
        commission: stop.commission,
        reason: endReason,
      },
      ...(requestId !== undefined ? { requestId } : {}),
    },
    session,
  );
  return stop.commission;
}

/**
 * Stop a plan. Mid-cycle that charges its one payment on the spot (client
 * rule, 30 Sep 2026); the rest of the money stays in the balance.
 */
export async function stopPlan(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  planId: Types.ObjectId,
  requestId?: string,
): Promise<StopPlanResult> {
  const pre = await liveAccount(actor, accountId);
  const prePlan = await SusuPlanModel.findOne({ _id: planId, accountId });
  if (!prePlan) throw new AppError('NOT_FOUND', 'Plan not found', 404);
  if (pre.status !== 'active') throw new AppError('ACCOUNT_CLOSED', 'The account is closed', 422);
  if (prePlan.status !== 'active') {
    throw new AppError('PLAN_STOPPED', 'This plan is already stopped', 422);
  }
  const customer = await loadCustomer(pre.customerId);

  let commission = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ACCOUNT_CLOSED', 'The account is closed', 422);
      const plan = await SusuPlanModel.findOne({ _id: planId, status: 'active' }).session(session);
      if (!plan) throw new AppError('PLAN_STOPPED', 'This plan is already stopped', 422);
      commission = await stopPlanWithin(session, actor, account, plan, 'plan-stopped', requestId);
      // The lock guarantees this; a balance that cannot cover it is corrupt data.
      if (commission > account.balance) {
        throw new AppError('INTERNAL_ERROR', 'Balance does not cover the locked commission', 500);
      }
      await moveBalance(session, account, -commission);
    });
  } finally {
    await session.endSession();
  }

  const [account, plan] = await Promise.all([
    publicAccount(accountId),
    SusuPlanModel.findById(planId),
  ]);
  if (!plan) throw new AppError('NOT_FOUND', 'Plan not found', 404);
  if (commission > 0) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-plan-stopped',
      message:
        `Yadah: your ${formatGhs(plan.dailyAmount)}/day susu plan has been stopped. ` +
        `Commission ${formatGhs(commission)} taken. Balance: ${formatGhs(account.balance)}.`,
      relatedEntityType: 'susu-plan',
      relatedEntityId: planId,
    });
  }
  emitAdminEvent('susu.plan.stopped', {
    accountId: accountId.toHexString(),
    planId: planId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer.fullName,
    commission,
  });
  return { account, plan: toPublicPlan(plan), commission };
}

// ---------------------------------------------------------------- deposits

export interface DepositResult {
  deposit: PublicDeposit;
  account: PublicSusuAccount;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

/**
 * Turn a request's split into the domain's, refusing what the domain would
 * refuse but with a code the counter can act on. `split` omitted means one
 * payment on every active plan.
 */
function resolveSplit(
  plans: readonly SusuPlan[],
  split: readonly PlanSplit[] | undefined,
): PlanSplit[] {
  const states = planStates(plans);
  if (split === undefined) {
    const out = defaultSplit(states);
    if (out.length === 0) {
      throw new AppError('NO_ACTIVE_PLANS', 'This account has no active plan to pay into', 422);
    }
    return out;
  }
  return split.map((s) => ({ planId: s.planId, payments: s.payments }));
}

function allocateStates(
  amount: number,
  states: readonly PlanState[],
  split: readonly PlanSplit[],
): DepositAllocation {
  try {
    return allocateDeposit(amount, states, split);
  } catch (err) {
    const covered = split.reduce((sum, s) => {
      const state = states.find((p) => p.planId === s.planId);
      return state ? sum + state.dailyAmount * s.payments : sum;
    }, 0);
    return asApiError(err, 'INVALID_SPLIT', { amount, required: covered });
  }
}

function allocate(
  amount: number,
  plans: readonly SusuPlan[],
  split: readonly PlanSplit[],
): DepositAllocation {
  return allocateStates(amount, planStates(plans), split);
}

/** The deposit lines an allocation writes, one per cycle chunk. */
function linesOf(allocation: DepositAllocation): SusuDepositLine[] {
  return allocation.plans.flatMap((p) =>
    p.chunks.map((c) => {
      const commission = p.commissions.find((k) => k.cycleNumber === c.cycleNumber);
      return {
        planId: new Types.ObjectId(p.planId),
        dailyAmount: p.amount / p.payments,
        cycleNumber: c.cycleNumber,
        payments: c.payments,
        seqStart: c.seqStart,
        seqEnd: c.seqEnd,
        amount: (p.amount / p.payments) * c.payments,
        commissionAmount: c.completesCycle && commission ? commission.amount : 0,
      };
    }),
  );
}

/**
 * Inside a transaction: credit an allocation to the plans, record the cycles
 * it completed, and return the lines. The caller writes the deposit and moves
 * the balance.
 */
async function creditPlans(
  session: ClientSession,
  account: SusuAccount,
  plans: readonly SusuPlan[],
  allocation: DepositAllocation,
  depositId: Types.ObjectId,
  at: Date,
): Promise<SusuDepositLine[]> {
  for (const line of allocation.plans) {
    const plan = plans.find((p) => p._id.toHexString() === line.planId);
    if (!plan) throw conflict();
    await movePlan(session, plan, line.after);
    for (const done of line.commissions) {
      await SusuCycleModel.create(
        [
          {
            planId: plan._id,
            accountId: account._id,
            customerId: account.customerId,
            cycleNumber: done.cycleNumber,
            dailyAmount: plan.dailyAmount,
            payments: SUSU_CYCLE_PAYMENTS,
            commissionAmount: done.amount,
            endReason: 'completed',
            endedAt: at,
            completedByDepositId: depositId,
          },
        ],
        { session },
      );
    }
  }
  return linesOf(allocation);
}

export interface MoneyIn {
  channel: Channel;
  idempotencyKey: string;
  /** The day the money moved; defaults to now. */
  at?: Date;
  requestId?: string;
}

/**
 * Inside the caller's transaction: credit a deposit to an open account. The
 * plans and the balance are re-read under the session — a concurrent deposit
 * may have moved a plan, which changes where its cycle boundary falls. Shared
 * by the cash deposit here, the transfers that move savings into susu, and
 * the Paystack webhook.
 *
 * `split` is the resolved per-plan payments; pass `undefined` for one on
 * every active plan.
 */
export async function depositWithin(
  session: ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  split: readonly PlanSplit[] | undefined,
  input: MoneyIn,
): Promise<SusuDeposit> {
  const at = input.at ?? new Date();
  const account = await SusuAccountModel.findOne({
    _id: accountId,
    status: 'active',
    ...NOT_TRASHED,
  }).session(session);
  if (!account) {
    throw new AppError('ACCOUNT_CLOSED', 'Deposits are only allowed on an open account', 422);
  }
  const plans = await loadPlans(accountId, session);
  const resolved = resolveSplit(plans, split);
  const allocation = allocate(amount, plans, resolved);
  const depositId = new Types.ObjectId();
  const lines = await creditPlans(session, account, plans, allocation, depositId, at);

  const [created] = await SusuDepositModel.create(
    [
      {
        _id: depositId,
        accountId: account._id,
        customerId: account.customerId,
        collectorId: new Types.ObjectId(actor.sub),
        amount,
        lines,
        leftover: allocation.leftover,
        commissionAmount: allocation.commissionTotal,
        channel: input.channel,
        idempotencyKey: input.idempotencyKey,
        // `createdAt` is the day the money moved and is what every report
        // reads; `updatedAt` is when the row was written.
        createdAt: at,
        updatedAt: new Date(),
      },
    ],
    { session, timestamps: false },
  );

  // Money conservation, checked before the commit.
  const linesTotal = lines.reduce((sum, l) => sum + l.amount, 0);
  if (linesTotal + allocation.leftover !== amount) {
    throw new AppError('INTERNAL_ERROR', 'Deposit split did not conserve the amount', 500);
  }
  await moveBalance(session, account, allocation.balanceDelta);

  await audit(
    {
      actorId: actor.sub,
      action: 'susu.deposit.record',
      entityType: 'susu-account',
      entityId: account._id,
      amountBefore: account.balance,
      amountAfter: account.balance + allocation.balanceDelta,
      after: {
        depositId: depositId.toHexString(),
        amount,
        leftover: allocation.leftover,
        commission: allocation.commissionTotal,
        channel: input.channel,
        lines: lines.map((l) => ({
          planId: l.planId.toHexString(),
          cycle: l.cycleNumber,
          seq: `${String(l.seqStart)}-${String(l.seqEnd)}`,
        })),
      },
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    },
    session,
  );
  return created as SusuDeposit;
}

/**
 * The split a payment from outside the counter is credited with — Paystack,
 * the portal, a transfer — where nobody is there to choose: as many whole
 * rounds (one payment on every active plan) as the amount buys, the rest
 * leftover. Refuses an amount short of one round, with what one round costs.
 */
export async function roundsSplit(
  accountId: Types.ObjectId,
  amount: number,
): Promise<{ split: PlanSplit[]; rounds: number; dailyTotal: number }> {
  const plans = (await loadPlans(accountId)).filter((p) => p.status === 'active');
  const dailyTotal = plans.reduce((sum, p) => sum + p.dailyAmount, 0);
  if (dailyTotal === 0) {
    throw new AppError('NO_ACTIVE_PLANS', 'This account has no active plan to pay into', 422);
  }
  const rounds = Math.floor(amount / dailyTotal);
  if (rounds < 1) {
    throw new AppError(
      'AMOUNT_MISMATCH',
      `A susu payment must cover at least one day on every plan (${formatGhs(dailyTotal)})`,
      422,
      { dailyTotal },
    );
  }
  return {
    split: plans.map((p) => ({ planId: p._id.toHexString(), payments: rounds })),
    rounds,
    dailyTotal,
  };
}

/**
 * Record a collection. The cash goes into the balance; the split says how
 * many whole payments it credits to each plan (one each by default). A plan
 * reaching its 31st payment completes its cycle, and one payment's amount is
 * taken as commission out of the deposit there and then; payments past the
 * 31st open the plan's next cycle at the same amount. Whatever the split does
 * not use stays in the balance as leftover.
 */
export async function recordDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
  occurredOn?: string,
  split?: readonly PlanSplit[],
): Promise<DepositResult> {
  // The day the cash actually changed hands. Resolved before anything is
  // read, so a date the server will not accept costs nothing.
  const at = resolveOccurredAt(actor, occurredOn);
  // Replay of a retried mobile request → return the original, write nothing.
  const prior = await SusuDepositModel.findOne({ idempotencyKey });
  if (prior) {
    if (prior.deletedAt) {
      throw new AppError(
        'CONFLICT',
        'The original deposit was moved to the trash — use a new idempotency key',
        409,
      );
    }
    return {
      deposit: toPublicDeposit(prior),
      account: await publicAccount(prior.accountId),
      replayed: true,
    };
  }

  const pre = await liveAccount(actor, accountId);
  if (pre.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'Deposits are only allowed on an open account', 422);
  }
  // Pre-flight outside the transaction, so a refusal costs no session.
  const prePlans = await loadPlans(accountId);
  const resolved = resolveSplit(prePlans, split);
  allocate(amount, prePlans, resolved);
  const customer = await loadCustomer(pre.customerId);

  let written!: SusuDeposit;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      written = await depositWithin(session, actor, accountId, amount, resolved, {
        channel,
        idempotencyKey,
        at,
        ...(requestId !== undefined ? { requestId } : {}),
      });
    });
  } finally {
    await session.endSession();
  }

  const account = await publicAccount(accountId);
  const deposit = toPublicDeposit(written);

  // Post-commit, fire-and-forget: receipt + live feed.
  const progress = account.plans
    .filter((p) => p.status === 'active')
    .map(
      (p) => `${formatGhs(p.dailyAmount)}/day: ${String(p.paidInCycle)}/${String(p.cycleTarget)}`,
    )
    .join(', ');
  const completed = deposit.lines.filter((l) => l.completesCycle).length;
  await enqueueSms({
    to: customer.phone,
    template: 'susu-deposit-receipt',
    message:
      `Yadah: ${formatGhs(amount)} received on susu acct ${account.accountNumber}. ` +
      (completed > 0
        ? `${String(completed)} cycle${completed === 1 ? '' : 's'} completed (commission ${formatGhs(deposit.commissionAmount)}). `
        : '') +
      `${progress}. Balance: ${formatGhs(account.balance)}.`,
    relatedEntityType: 'susu-deposit',
    relatedEntityId: written._id,
  });
  emitAdminEvent('susu.deposit.recorded', {
    accountId: accountId.toHexString(),
    depositId: deposit.id,
    customerId: customer._id.toHexString(),
    customerName: customer.fullName,
    amount,
    commission: deposit.commissionAmount,
    cyclesCompleted: completed,
    balance: account.balance,
  });
  return { deposit, account, replayed: false };
}

// ---------------------------------------------------------------- withdrawals

export interface PublicWithdrawalLine {
  planId: string;
  /** The plan's amount at the time. */
  dailyAmount: number;
  amount: number;
  /** Whole payments this share took off the plan's cycle in progress. */
  paymentsRemoved: number;
}

export interface WithdrawalResult {
  account: PublicSusuAccount;
  amount: number;
  payoutId: string;
  /** What came off which plan, in the order the money walked them. */
  lines: PublicWithdrawalLine[];
  /** The part that sat on no plan. */
  loose: number;
  /** True when this response replays an earlier identical request. */
  replayed: boolean;
}

export interface MoneyOut {
  destination: 'cash' | 'savings' | 'loan' | 'hire-purchase';
  destinationId?: Types.ObjectId;
  /**
   * Whether the plans' shares take days off their cycles. Cash across the
   * counter does (user decision, 30 Sep 2026); a transfer or a loan repayment
   * paid from susu records its shares but leaves the cycles where they were.
   */
  costsDays?: boolean;
  idempotencyKey: string;
  requestId?: string;
}

function toPublicWithdrawalLine(l: SusuPayoutLine): PublicWithdrawalLine {
  return {
    planId: l.planId.toHexString(),
    dailyAmount: l.dailyAmount,
    amount: l.amount,
    paymentsRemoved: l.paymentsRemoved,
  };
}

/**
 * Inside the caller's transaction: take money out of an open account. The
 * account-wide lock decides whether it may leave at all; then the money walks
 * the plans (running first, oldest first), each giving what it holds less its
 * own lock and each share taking whole payments off that plan's cycle in
 * progress. Shared by the cash withdrawal here and by the transfers that pay
 * a loan, an instalment or a savings account from susu — every route out of
 * the balance stops at the same lock and leaves the same per-plan trail.
 */
export async function withdrawWithin(
  session: ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  out: MoneyOut,
): Promise<{
  account: SusuAccount;
  payoutId: Types.ObjectId;
  balanceAfter: number;
  lines: PublicWithdrawalLine[];
  loose: number;
}> {
  const account = await SusuAccountModel.findOne({
    _id: accountId,
    status: 'active',
    ...NOT_TRASHED,
  }).session(session);
  if (!account) throw new AppError('ACCOUNT_CLOSED', 'The susu account is not open', 422);
  const plans = await loadPlans(accountId, session);
  // The lock is judged on the plans as they stand: a share that empties a
  // cycle still leaves that cycle's one payment behind.
  const states = planStates(plans);
  const computation = (() => {
    try {
      return computeWithdrawal(account.balance, states, amount);
    } catch (err) {
      return asApiError(err, 'EXCEEDS_AVAILABLE', {
        available: maxWithdrawal(account.balance, states),
        balance: account.balance,
        locked: lockedAmount(states),
      });
    }
  })();

  const money = await planMoney(accountId, plans, session);
  const ordered = orderPlans(plans);
  const allocation = allocateWithdrawal(
    ordered.map((p) => ({ ...stateOf(p), balance: money.get(p._id.toHexString())?.balance ?? 0 })),
    amount,
    out.costsDays ?? false,
  );

  await moveBalance(session, account, -amount);
  for (const line of allocation.lines) {
    if (line.payments === 0) continue;
    const plan = ordered.find((p) => p._id.toHexString() === line.planId);
    if (plan) await movePlan(session, plan, line.after);
  }
  const lines: SusuPayoutLine[] = allocation.lines.map((l) => ({
    planId: new Types.ObjectId(l.planId),
    dailyAmount: l.dailyAmount,
    amount: l.amount,
    paymentsRemoved: l.payments,
  }));
  const [payout] = await SusuPayoutModel.create(
    [
      {
        accountId: account._id,
        customerId: account.customerId,
        amount,
        kind: 'withdrawal',
        ...(lines.length > 0 ? { lines } : {}),
        destination: out.destination,
        ...(out.destinationId ? { destinationId: out.destinationId } : {}),
        // Never charged here: commission is taken as cycles complete.
        commissionAmount: 0,
        recordedById: new Types.ObjectId(actor.sub),
        idempotencyKey: out.idempotencyKey,
      },
    ],
    { session },
  );
  await audit(
    {
      actorId: actor.sub,
      action: 'susu.withdrawal',
      entityType: 'susu-account',
      entityId: account._id,
      amountBefore: account.balance,
      amountAfter: computation.balanceAfter,
      after: {
        amount,
        locked: computation.locked,
        destination: out.destination,
        lines: allocation.lines.map((l) => ({
          planId: l.planId,
          amount: l.amount,
          paymentsRemoved: l.payments,
          planAfter: l.after,
        })),
        loose: allocation.loose,
        ...(out.destinationId ? { destinationId: out.destinationId.toHexString() } : {}),
      },
      ...(out.requestId !== undefined ? { requestId: out.requestId } : {}),
    },
    session,
  );
  return {
    account,
    payoutId: (payout as { _id: Types.ObjectId })._id,
    balanceAfter: computation.balanceAfter,
    lines: lines.map(toPublicWithdrawalLine),
    loose: allocation.loose,
  };
}

/** Cash across the counter. No commission, the lock respected, the plans each recording their share. */
export async function withdraw(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  requestId?: string,
): Promise<WithdrawalResult> {
  const existing = await SusuPayoutModel.findOne({ idempotencyKey });
  if (existing) {
    const lines = (existing.lines ?? []).map(toPublicWithdrawalLine);
    return {
      account: await publicAccount(existing.accountId),
      amount: existing.amount,
      payoutId: existing._id.toHexString(),
      lines,
      loose: existing.amount - lines.reduce((sum, l) => sum + l.amount, 0),
      replayed: true,
    };
  }

  const pre = await liveAccount(actor, accountId);
  if (pre.status !== 'active') {
    throw new AppError('ACCOUNT_CLOSED', 'Withdrawals need an open account', 422);
  }
  const preStates = planStates(await loadPlans(accountId));
  const available = maxWithdrawal(pre.balance, preStates);
  if (amount > available) {
    const locked = lockedAmount(preStates);
    throw new AppError(
      'EXCEEDS_AVAILABLE',
      available === 0
        ? `Nothing is withdrawable — ${formatGhs(locked)} stays locked for the cycles in progress`
        : `Only ${formatGhs(available)} is withdrawable; ${formatGhs(locked)} stays locked for the cycles in progress`,
      422,
      { available, balance: pre.balance, locked },
    );
  }
  const customer = await loadCustomer(pre.customerId);

  let payoutId!: Types.ObjectId;
  let lines: PublicWithdrawalLine[] = [];
  let loose = 0;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const r = await withdrawWithin(session, actor, accountId, amount, {
        destination: 'cash',
        costsDays: true,
        idempotencyKey,
        ...(requestId !== undefined ? { requestId } : {}),
      });
      payoutId = r.payoutId;
      lines = r.lines;
      loose = r.loose;
    });
  } finally {
    await session.endSession();
  }

  const account = await publicAccount(accountId);
  await enqueueSms({
    to: customer.phone,
    template: 'susu-withdrawal',
    message:
      `Yadah: ${formatGhs(amount)} withdrawn from susu acct ${account.accountNumber}. ` +
      `Balance: ${formatGhs(account.balance)}.`,
    relatedEntityType: 'susu-account',
    relatedEntityId: accountId,
  });
  emitAdminEvent('susu.withdrawal', {
    id: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer.fullName,
    amount,
    balance: account.balance,
  });
  notifyOffice({
    type: 'susu.withdrawal',
    title: 'Susu withdrawal',
    body: `${formatGhs(amount)} withdrawn from ${customer.fullName} (acct ${account.accountNumber}).`,
    data: { entity: 'susu-account', accountId: accountId.toHexString(), amount },
  });
  return { account, amount, payoutId: payoutId.toHexString(), lines, loose, replayed: false };
}

// ---------------------------------------------------------------- closure

export interface ClosureResult {
  account: PublicSusuAccount;
  /** Σ one payment per plan that was mid-cycle. */
  commission: number;
  payout: number;
  payoutId: string;
}

/**
 * The customer leaves: every plan mid-cycle is stopped and charged its one
 * payment, and the rest of the balance is paid out in cash. The account keeps
 * its number and history and can be reopened.
 */
export async function closeAccount(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  requestId?: string,
): Promise<ClosureResult> {
  const pre = await liveAccount(actor, accountId);
  if (pre.status === 'closed') {
    throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
  }
  const customer = await loadCustomer(pre.customerId);

  let result!: Omit<ClosureResult, 'account'>;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Account is already closed', 409);
      const plans = await loadPlans(accountId, session);
      const close = computeClose(account.balance, planStates(plans));

      let charged = 0;
      for (const plan of plans) {
        if (plan.status !== 'active') continue;
        charged += await stopPlanWithin(session, actor, account, plan, 'account-closed', requestId);
      }
      if (charged !== close.commission) {
        throw new AppError('INTERNAL_ERROR', 'Closure commission did not reconcile', 500);
      }

      const now = new Date();
      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: 'active', balance: account.balance, ...NOT_TRASHED },
        {
          $set: {
            status: 'closed',
            balance: 0,
            closedAt: now,
            closedById: new Types.ObjectId(actor.sub),
            closeCommission: close.commission,
            closePayout: close.payout,
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) throw conflict();

      // The cash disbursement itself — written even at zero, so a closure
      // that charged commission and paid nothing is still on the feed.
      const [payout] = await SusuPayoutModel.create(
        [
          {
            accountId: account._id,
            customerId: account.customerId,
            amount: close.payout,
            kind: 'payout',
            destination: 'cash',
            commissionAmount: close.commission,
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey: `close:${account._id.toHexString()}:${now.toISOString()}`,
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
          amountBefore: account.balance,
          amountAfter: 0,
          after: { commission: close.commission, payout: close.payout },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
      result = {
        commission: close.commission,
        payout: close.payout,
        payoutId: (payout as { _id: Types.ObjectId })._id.toHexString(),
      };
    });
  } finally {
    await session.endSession();
  }

  await enqueueSms({
    to: customer.phone,
    template: 'susu-closure',
    message:
      `Yadah: susu acct ${pre.accountNumber} has been closed. Payout: ${formatGhs(result.payout)} ` +
      `(commission ${formatGhs(result.commission)}). Thank you!`,
    relatedEntityType: 'susu-account',
    relatedEntityId: accountId,
  });
  emitAdminEvent('susu.account.closed', {
    id: accountId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer.fullName,
    payout: result.payout,
    commission: result.commission,
  });
  return { ...result, account: await publicAccount(accountId) };
}

// ---------------------------------------------------------------- trash

export interface PublicTrashedSusuAccount extends PublicSusuAccount {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toPublicTrashedAccount(
  a: SusuAccount,
  plans: readonly SusuPlan[],
): PublicTrashedSusuAccount {
  return {
    ...toPublicAccount(a, plans),
    deletedAt: requireDeletedAt(a.deletedAt),
    ...(a.deletedById ? { deletedById: a.deletedById.toHexString() } : {}),
    ...(a.deleteReason !== undefined ? { deleteReason: a.deleteReason } : {}),
  };
}

/**
 * Moves an account to the trash. Only an account that never held money
 * qualifies — one with history goes through close so the ledger keeps it.
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
  if (account.status !== 'active' || account.balance !== 0 || depositRecords !== 0) {
    throw new AppError(
      'CANNOT_TRASH',
      'Only empty, unused susu accounts can be moved to the trash',
      422,
      { status: account.status, balance: account.balance, depositRecords },
    );
  }
  const customer = await CustomerModel.findById(account.customerId);

  const now = new Date();
  const upd = await SusuAccountModel.updateOne(
    { _id: accountId, ...NOT_TRASHED, status: 'active', balance: 0 },
    {
      $set: {
        deletedAt: now,
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
  );
  if (upd.modifiedCount !== 1) throw conflict();

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
  return toPublicTrashedAccount(account, await loadPlans(accountId));
}

/** Restores a trashed account. Refused when the customer has since opened another. */
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
  const other = await SusuAccountModel.exists({ customerId: account.customerId, ...NOT_TRASHED });
  if (other) {
    throw new AppError(
      'CANNOT_RESTORE',
      'The customer already has a susu account — a customer holds only one',
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
  return publicAccount(accountId);
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
  const [names, plans] = await Promise.all([
    customerNamesById(accounts.map((a) => a.customerId)),
    plansByAccount(accounts),
  ]);
  const items = accounts.map((a) => ({
    ...toPublicTrashedAccount(a, plans.get(a._id.toHexString()) ?? []),
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
    payments: number;
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
  const nameById = await customerNamesById(deposits.map((d) => d.customerId));

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
      payments: d.lines.reduce((sum, l) => sum + l.payments, 0),
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

function planIdsOf(deposit: SusuDeposit): Types.ObjectId[] {
  const seen = new Map<string, Types.ObjectId>();
  for (const l of deposit.lines) seen.set(l.planId.toHexString(), l.planId);
  return [...seen.values()];
}

/**
 * Corrections only touch the most recent deposit on every plan it paid: a
 * cycle is a contiguous 1..31 sequence, so changing anything older would
 * renumber every later payment. Transfer-created deposits are off-limits (the
 * transfer leg would be orphaned), and so is a plan stopped since — its
 * unfinished cycle is already on the books.
 */
async function assertCorrectable(
  account: SusuAccount,
  plans: readonly SusuPlan[],
  deposit: SusuDeposit,
  session?: ClientSession,
): Promise<void> {
  if (account.status !== 'active') {
    throw new AppError('CANNOT_TRASH', 'The account is closed — it keeps its history', 422);
  }
  if (deposit.channel === 'transfer') {
    throw new AppError(
      'CANNOT_TRASH',
      'Deposits created by a transfer cannot be changed on their own',
      422,
    );
  }
  for (const planId of planIdsOf(deposit)) {
    const plan = plans.find((p) => p._id.equals(planId));
    if (plan?.status !== 'active') {
      throw new AppError(
        'CANNOT_TRASH',
        'A plan this deposit paid has since been stopped — its cycle is already on the books',
        422,
      );
    }
    const q = SusuDepositModel.findOne({ 'lines.planId': planId, ...NOT_TRASHED })
      .sort({ createdAt: -1, _id: -1 })
      .select('_id');
    const latest = await (session ? q.session(session) : q);
    if (!latest?._id.equals(deposit._id)) {
      throw new AppError(
        'CANNOT_TRASH',
        'Only the most recent deposit on a plan can be changed — correct from the end',
        422,
        { planId: planId.toHexString(), latestDepositId: latest?._id.toHexString() },
      );
    }
  }
}

/**
 * Inside a transaction: un-credit a deposit's lines from the plans, delete
 * the cycles it completed, and return what the balance must give back
 * (amount − commission). The caller moves the balance and checks the lock.
 */
async function uncreditPlans(
  session: ClientSession,
  plans: readonly SusuPlan[],
  deposit: SusuDeposit,
): Promise<void> {
  // Latest line first, per plan — the reverse of how they were credited.
  const byPlan = new Map<string, SusuDepositLine[]>();
  for (const l of deposit.lines) {
    const key = l.planId.toHexString();
    const list = byPlan.get(key);
    if (list) list.push(l);
    else byPlan.set(key, [l]);
  }
  for (const [key, lines] of byPlan) {
    const plan = plans.find((p) => p._id.toHexString() === key);
    if (!plan) throw conflict();
    let paid = plan.paidInCycle;
    let completed = plan.cyclesCompleted;
    for (const line of [...lines].reverse()) {
      const complete = line.seqEnd === SUSU_CYCLE_PAYMENTS;
      // The plan must stand exactly where this line left it. Short of it
      // means a withdrawal has since taken those days off the plan — the
      // deposit's payments are gone and cannot be taken back a second time.
      const expectPaid = complete ? 0 : line.seqEnd;
      const expectCompleted = complete ? line.cycleNumber : line.cycleNumber - 1;
      if (completed < expectCompleted || (completed === expectCompleted && paid < expectPaid)) {
        throw new AppError(
          'CANNOT_TRASH',
          'Payments from this deposit have since been withdrawn off the plan — it cannot be taken back',
          422,
          { paidInCycle: paid, expected: expectPaid },
        );
      }
      if (paid !== expectPaid || completed !== expectCompleted) throw conflict();
      if (complete) {
        const del = await SusuCycleModel.deleteOne(
          {
            planId: plan._id,
            cycleNumber: line.cycleNumber,
            endReason: 'completed',
            completedByDepositId: deposit._id,
          },
          { session },
        );
        if (del.deletedCount !== 1) throw conflict();
      }
      paid = line.seqStart - 1;
      completed = line.cycleNumber - 1;
    }
    await movePlan(session, plan, { paidInCycle: paid, cyclesCompleted: completed });
  }
}

export async function trashDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  reason: string | undefined,
  requestId?: string,
): Promise<{ deposit: TrashedDeposit; account: PublicSusuAccount }> {
  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const preDeposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!preDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  await assertCorrectable(pre, await loadPlans(accountId), preDeposit);

  const now = new Date();
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw conflict();
      const deposit = await SusuDepositModel.findOne({ _id: depositId, ...NOT_TRASHED }).session(
        session,
      );
      if (!deposit) throw conflict();
      const plans = await loadPlans(accountId, session);
      await assertCorrectable(account, plans, deposit, session);
      await uncreditPlans(session, plans, deposit);

      // The money goes back out of the balance — unless it has since been
      // withdrawn, in which case there is nothing to give back.
      const giveBack = deposit.amount - deposit.commissionAmount;
      const after = await loadPlans(accountId, session);
      const balanceAfter = account.balance - giveBack;
      if (balanceAfter < lockedAmount(planStates(after))) {
        throw new AppError(
          'CANNOT_TRASH',
          'The money from this deposit has since been withdrawn — the balance cannot give it back',
          422,
          { balance: account.balance, giveBack },
        );
      }
      await moveBalance(session, account, -giveBack);

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
      if (depositUpd.modifiedCount !== 1) throw conflict();
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.trash',
          entityType: 'susu-deposit',
          entityId: depositId,
          amountBefore: account.balance,
          amountAfter: balanceAfter,
          before: { amount: deposit.amount, deletedAt: null },
          after: {
            amount: deposit.amount,
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

  const afterDeposit = await SusuDepositModel.findById(depositId);
  if (!afterDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  const account = await publicAccount(accountId);
  emitAdminEvent('susu.deposit.trashed', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amount: preDeposit.amount,
    balance: account.balance,
  });
  return { deposit: toTrashedDeposit(afterDeposit), account };
}

/**
 * Re-credits a trashed deposit. Only possible while every plan it paid still
 * stands where the deposit found it (nothing newer recorded since).
 */
export async function restoreDeposit(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  requestId?: string,
): Promise<DepositResult> {
  const pre = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const preDeposit = await SusuDepositModel.findOne({ _id: depositId, accountId });
  if (!preDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  if (!preDeposit.deletedAt) {
    throw new AppError('NOT_TRASHED', 'Deposit is not in the trash', 409);
  }
  if (pre.status !== 'active') {
    throw new AppError('CANNOT_RESTORE', 'The account is closed', 422);
  }

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: accountId,
        status: 'active',
        ...NOT_TRASHED,
      }).session(session);
      if (!account) throw conflict();
      const deposit = await SusuDepositModel.findOne({
        _id: depositId,
        deletedAt: { $ne: null },
      }).session(session);
      if (!deposit) throw conflict();
      const plans = await loadPlans(accountId, session);

      // Re-run the split against the plans as they stand; it must land on
      // exactly the lines the deposit already has, or the positions are taken.
      const split = planIdsOf(deposit).map((planId) => ({
        planId: planId.toHexString(),
        payments: deposit.lines
          .filter((l) => l.planId.equals(planId))
          .reduce((sum, l) => sum + l.payments, 0),
      }));
      let allocation: DepositAllocation;
      try {
        allocation = allocateDeposit(deposit.amount, planStates(plans), split);
      } catch (err) {
        return asApiError(err, 'CANNOT_RESTORE');
      }
      const fresh = linesOf(allocation);
      const same =
        fresh.length === deposit.lines.length &&
        fresh.every((l, i) => {
          const o = deposit.lines[i];
          return (
            o !== undefined &&
            l.planId.equals(o.planId) &&
            l.cycleNumber === o.cycleNumber &&
            l.seqStart === o.seqStart &&
            l.seqEnd === o.seqEnd &&
            l.amount === o.amount
          );
        });
      if (!same) {
        throw new AppError(
          'CANNOT_RESTORE',
          'The deposit’s cycle positions are no longer free — something newer was recorded',
          422,
        );
      }
      await creditPlans(session, account, plans, allocation, depositId, deposit.createdAt);
      await moveBalance(session, account, allocation.balanceDelta);

      const depositUpd = await SusuDepositModel.updateOne(
        { _id: depositId, deletedAt: { $ne: null } },
        { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
        { session },
      );
      if (depositUpd.modifiedCount !== 1) throw conflict();
      await audit(
        {
          actorId: actor.sub,
          action: 'susu.deposit.restore',
          entityType: 'susu-deposit',
          entityId: depositId,
          amountBefore: account.balance,
          amountAfter: account.balance + allocation.balanceDelta,
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

  const afterDeposit = await SusuDepositModel.findById(depositId);
  if (!afterDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  const account = await publicAccount(accountId);
  emitAdminEvent('susu.deposit.restored', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amount: preDeposit.amount,
    balance: account.balance,
  });
  return { deposit: toPublicDeposit(afterDeposit), account, replayed: false };
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

/**
 * The split a corrected amount is credited with. Given explicitly, it is
 * used as-is. Omitted, it is derived only when the deposit paid one plan:
 * as many whole payments as the amount buys, the rest as leftover. A
 * deposit that was split across plans cannot be re-split by guesswork.
 */
function correctionSplit(
  deposit: SusuDeposit,
  plans: readonly SusuPlan[],
  amount: number,
  split: readonly PlanSplit[] | undefined,
): PlanSplit[] {
  if (split !== undefined) return split.map((s) => ({ planId: s.planId, payments: s.payments }));
  const planIds = planIdsOf(deposit);
  const only = planIds[0];
  if (planIds.length !== 1 || !only) {
    throw new AppError(
      'SPLIT_REQUIRED',
      'This deposit was split across plans — say how the corrected amount splits',
      422,
      { planIds: planIds.map((p) => p.toHexString()) },
    );
  }
  const plan = plans.find((p) => p._id.equals(only));
  if (!plan) throw conflict();
  return [{ planId: only.toHexString(), payments: Math.floor(amount / plan.dailyAmount) }];
}

/**
 * The pure half of planning a correction: what crediting `amount` would do,
 * against the plans as they stood BEFORE this deposit (its lines rewound in
 * memory). Throws the same 422s the office would see.
 */
function planCorrectionSync(
  plans: readonly SusuPlan[],
  deposit: SusuDeposit,
  amount: number,
  split: readonly PlanSplit[] | undefined,
): { split: PlanSplit[]; allocation: DepositAllocation } {
  // A Paystack deposit's amount is what Paystack charged, not what somebody
  // typed. There is no data-entry mistake in it to correct.
  if (deposit.channel === 'paystack') {
    throw new AppError(
      'CANNOT_CORRECT',
      'This was paid through Paystack, so the amount is what was charged',
      422,
    );
  }
  const resolved = correctionSplit(deposit, plans, amount, split);
  const rewound = planStates(plans).map((state) => {
    const mine = deposit.lines.filter((l) => l.planId.toHexString() === state.planId);
    const first = mine[0];
    if (!first) return state;
    return { ...state, paidInCycle: first.seqStart - 1, cyclesCompleted: first.cycleNumber - 1 };
  });
  return { split: resolved, allocation: allocateStates(amount, rewound, resolved) };
}

/**
 * What correcting this deposit to `amount` would credit, or why it cannot be
 * done. Checked when a teller proposes it — so they hear the refusal at the
 * counter — and again when the office applies it, against the plans as they
 * stand then.
 */
async function planCorrection(
  account: SusuAccount,
  plans: readonly SusuPlan[],
  deposit: SusuDeposit,
  amount: number,
  split: readonly PlanSplit[] | undefined,
  session?: ClientSession,
): Promise<{ split: PlanSplit[]; allocation: DepositAllocation }> {
  await assertCorrectable(account, plans, deposit, session);
  return planCorrectionSync(plans, deposit, amount, split);
}

/**
 * The correction itself, inside the caller's transaction: the deposit is
 * un-credited and credited afresh at the new amount, keeping its id and its
 * date, and the balance moves by the difference — all committed or rolled
 * back together with whatever else the caller writes.
 */
async function applyCorrection(
  session: ClientSession,
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  depositId: Types.ObjectId,
  amount: number,
  split: readonly PlanSplit[] | undefined,
  requestId: string | undefined,
  origin: CorrectionOrigin | undefined,
): Promise<void> {
  const account = await SusuAccountModel.findOne({
    _id: accountId,
    status: 'active',
    ...NOT_TRASHED,
  }).session(session);
  if (!account) throw conflict();
  const deposit = await SusuDepositModel.findOne({ _id: depositId, ...NOT_TRASHED }).session(
    session,
  );
  if (!deposit) throw conflict();
  const plans = await loadPlans(accountId, session);
  const { allocation } = await planCorrection(account, plans, deposit, amount, split, session);

  await uncreditPlans(session, plans, deposit);
  const rewound = await loadPlans(accountId, session);
  const lines = await creditPlans(
    session,
    account,
    rewound,
    allocation,
    depositId,
    deposit.createdAt,
  );

  const before = deposit.amount - deposit.commissionAmount;
  const delta = allocation.balanceDelta - before;
  const balanceAfter = account.balance + delta;
  const after = await loadPlans(accountId, session);
  if (balanceAfter < lockedAmount(planStates(after))) {
    throw new AppError(
      'CANNOT_CORRECT',
      'The money from this deposit has since been withdrawn — the balance cannot give it back',
      422,
      { balance: account.balance, delta },
    );
  }
  await moveBalance(session, account, delta);

  const depositUpd = await SusuDepositModel.updateOne(
    { _id: depositId, ...NOT_TRASHED, amount: deposit.amount },
    {
      $set: {
        amount,
        lines,
        leftover: allocation.leftover,
        commissionAmount: allocation.commissionTotal,
      },
    },
    { session },
  );
  if (depositUpd.modifiedCount !== 1) throw conflict();
  await audit(
    {
      actorId: actor.sub,
      action: 'susu.deposit.update',
      entityType: 'susu-deposit',
      entityId: depositId,
      amountBefore: deposit.amount,
      amountAfter: amount,
      before: { amount: deposit.amount, commission: deposit.commissionAmount },
      after: {
        amount,
        commission: allocation.commissionTotal,
        leftover: allocation.leftover,
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
  split?: readonly PlanSplit[],
): Promise<DepositResult> {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  await planCorrection(account, await loadPlans(accountId), deposit, amount, split);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await applyCorrection(
        session,
        actor,
        accountId,
        depositId,
        amount,
        split,
        requestId,
        undefined,
      );
    });
  } finally {
    await session.endSession();
  }

  const afterDeposit = await SusuDepositModel.findById(depositId);
  if (!afterDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  const after = await publicAccount(accountId);
  emitAdminEvent('susu.deposit.updated', {
    accountId: accountId.toHexString(),
    depositId: depositId.toHexString(),
    amountBefore: deposit.amount,
    amountAfter: amount,
    balance: after.balance,
  });
  return { deposit: toPublicDeposit(afterDeposit), account: after, replayed: false };
}

// ---------------------------------------------------------------- corrections

/**
 * A deposit correction as the corrections module runs it: outright for the
 * office, or after a teller asked and the office approved. Only the amount
 * travels through that contract, so a deposit split across plans cannot be
 * corrected this way — the office re-splits it through PATCH instead.
 */
export const prepareDepositCorrection: CorrectionPreparer = async (accountId, depositId) => {
  const account = await SusuAccountModel.findOne({ _id: accountId, ...NOT_TRASHED });
  if (!account) throw new AppError('NOT_FOUND', 'Account not found', 404);
  const deposit = await SusuDepositModel.findOne({ _id: depositId, accountId, ...NOT_TRASHED });
  if (!deposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
  const plans = await loadPlans(accountId);
  // Correctable at all — the newest on its plan, on an open account — or the
  // teller hears so now rather than the office a day later.
  await assertCorrectable(account, plans, deposit);

  return {
    kind: 'susu-deposit',
    targetId: accountId,
    txnId: depositId,
    customerId: deposit.customerId,
    amount: deposit.amount,
    units: deposit.lines.reduce((sum, l) => sum + l.payments, 0),
    plan: (amount) => {
      // The contract is synchronous; the database checks ran above and run
      // again on apply.
      const { split } = planCorrectionSync(plans, deposit, amount, undefined);
      return { units: split.reduce((sum, s) => sum + s.payments, 0) };
    },
    apply: (session, actor, amount, requestId, origin) =>
      applyCorrection(session, actor, accountId, depositId, amount, undefined, requestId, origin),
    result: async () => {
      const afterDeposit = await SusuDepositModel.findById(depositId);
      if (!afterDeposit) throw new AppError('NOT_FOUND', 'Deposit not found', 404);
      return { target: await publicAccount(accountId), txn: toPublicDeposit(afterDeposit) };
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
export async function susuBalanceAsOf(accountId: Types.ObjectId, at: Date): Promise<number> {
  const [inFlow, outFlow, stops] = await Promise.all([
    SusuDepositModel.aggregate<{ total: number }>([
      { $match: { accountId, createdAt: { $lte: at }, ...NOT_TRASHED } },
      { $group: { _id: null, total: { $sum: { $subtract: ['$amount', '$commissionAmount'] } } } },
    ]),
    SusuPayoutModel.aggregate<{ total: number }>([
      { $match: { accountId, createdAt: { $lte: at } } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]),
    SusuCycleModel.aggregate<{ total: number }>([
      {
        $match: {
          accountId,
          endReason: { $in: ['plan-stopped', 'account-closed'] },
          endedAt: { $lte: at },
        },
      },
      { $group: { _id: null, total: { $sum: '$commissionAmount' } } },
    ]),
  ]);
  return (inFlow[0]?.total ?? 0) - (outFlow[0]?.total ?? 0) - (stops[0]?.total ?? 0);
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
  const account = await liveAccount(actor, accountId);
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

  const lines: ReceiptLine[] = deposit.lines.map((l) => ({
    label: `${formatGhs(l.dailyAmount)}/day · cycle ${String(l.cycleNumber)}`,
    value:
      l.payments === 1
        ? `1 payment (${String(l.seqEnd)} of ${String(SUSU_CYCLE_PAYMENTS)})`
        : `${String(l.payments)} payments (${String(l.seqStart)}–${String(l.seqEnd)} of ${String(SUSU_CYCLE_PAYMENTS)})` +
          (l.seqEnd === SUSU_CYCLE_PAYMENTS ? ' — cycle complete' : ''),
  }));
  if (deposit.commissionAmount > 0) {
    lines.push({
      label: 'Commission (cycle complete)',
      value: formatGhs(deposit.commissionAmount),
    });
  }
  if (deposit.leftover > 0) {
    lines.push({ label: 'Kept in balance', value: formatGhs(deposit.leftover) });
  }
  lines.push(
    {
      label: 'Balance after',
      value: formatGhs(await susuBalanceAsOf(accountId, deposit.createdAt)),
      emphasis: true,
    },
    { label: 'Payment method', value: deposit.channel },
  );

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

/** A withdrawal that leaves the account open, or the payout that closes it. */
export async function withdrawalReceipt(
  actor: AccessTokenPayload,
  accountId: Types.ObjectId,
  payoutId: Types.ObjectId,
): Promise<ReceiptFile> {
  const { account, customer } = await receiptContext(actor, accountId);
  const payout = await SusuPayoutModel.findOne({ _id: payoutId, accountId });
  if (!payout) throw new AppError('NOT_FOUND', 'Withdrawal not found', 404);

  const closing = payout.kind === 'payout';
  const lines: ReceiptLine[] = [];
  if (closing) {
    lines.push(
      { label: 'Commission (cycles in progress)', value: formatGhs(payout.commissionAmount ?? 0) },
      { label: 'Account status', value: 'Closed' },
    );
  } else {
    lines.push(
      {
        label: 'Balance after',
        value: formatGhs(await susuBalanceAsOf(accountId, payout.createdAt)),
        emphasis: true,
      },
      { label: 'Commission taken', value: 'None — taken as each cycle completes' },
      { label: 'Destination', value: payout.destination },
      { label: 'Account status', value: 'Still open' },
    );
  }

  const prefix = closing ? 'SP' : 'SW';
  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber(prefix, payout._id),
    kind: 'withdrawal',
    title: closing ? 'Susu Payout' : 'Susu Withdrawal',
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

/** Whether any plan on the account is mid-cycle — what the loan and HP checks read. */
export function hasCycleInProgress(account: PublicSusuAccount): boolean {
  return account.plans.some((p) => isMidCycle({ ...p, planId: p.id }));
}
