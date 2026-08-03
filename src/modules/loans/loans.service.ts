import mongoose, { Types } from 'mongoose';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import {
  CustomerModel,
  LoanConfigModel,
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  SavingsAccountModel,
  SavingsTxnModel,
  SusuAccountModel,
  SusuDepositModel,
  SusuPayoutModel,
  type Customer,
  type Loan,
  type Repayment,
  type SavingsAccount,
} from '../../models/index.js';
import { accraDay } from '../../lib/time.js';
import {
  DEFAULT_RATES,
  DEFAULT_TIERS,
  allocateRepayment,
  addMonthsClamped,
  buildSchedule,
  computeInterest,
  tierFor,
  type LoanDuration,
  type LoanRates,
  type TierLimits,
} from '../../domain/loans.js';
import { computeClosure } from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import type { Channel } from '../../models/shared.js';
import type { ListLoansQuery, PutConfigBody } from './loans.schemas.js';

// ---------------------------------------------------------------- config

export interface ActiveLoanConfig {
  rates: LoanRates;
  tiers: TierLimits;
}

export async function getLoanConfig(): Promise<ActiveLoanConfig> {
  const doc = await LoanConfigModel.findOne().sort({ updatedAt: -1 });
  if (!doc) return { rates: DEFAULT_RATES, tiers: DEFAULT_TIERS };
  return {
    rates: { 3: doc.ratePercent3, 6: doc.ratePercent6, 12: doc.ratePercent12 },
    tiers: {
      smallMin: doc.smallMinPesewas,
      smallMax: doc.smallMaxPesewas,
      bigMax: doc.bigMaxPesewas,
    },
  };
}

export async function putLoanConfig(
  actor: AccessTokenPayload,
  body: PutConfigBody,
  requestId?: string,
): Promise<ActiveLoanConfig> {
  const before = await getLoanConfig();
  await LoanConfigModel.findOneAndUpdate(
    {},
    { ...body, updatedById: new Types.ObjectId(actor.sub) },
    { upsert: true, sort: { updatedAt: -1 } },
  );
  const after = await getLoanConfig();
  await audit({
    actorId: actor.sub,
    action: 'loan.config.update',
    entityType: 'loan-config',
    entityId: new Types.ObjectId(actor.sub), // singleton; actor doubles as anchor
    before: before,
    after: after,
    ...(requestId !== undefined ? { requestId } : {}),
  });
  return after;
}

// ---------------------------------------------------------------- shapes

export interface PublicLoan {
  id: string;
  customerId: string;
  customerName?: string;
  tier: 'small' | 'big';
  principal: number;
  durationMonths: number;
  ratePercent: number;
  interestAmount: number;
  totalDue: number;
  totalRepaid: number;
  remaining: number;
  status: string;
  frozen: boolean;
  appliedAt: Date;
  approvedAt?: Date;
  dueDate?: Date;
  escalatedAt?: Date;
  closedAt?: Date;
  repaidOnTime?: boolean;
  rejectionReason?: string;
}

export function toPublicLoan(l: Loan): PublicLoan {
  return {
    id: l._id.toHexString(),
    customerId: l.customerId.toHexString(),
    tier: l.tier,
    principal: l.principal,
    durationMonths: l.durationMonths,
    ratePercent: l.ratePercent,
    interestAmount: l.interestAmount,
    totalDue: l.totalDue,
    totalRepaid: l.totalRepaid,
    remaining: l.totalDue - l.totalRepaid,
    status: l.status,
    frozen: l.frozen,
    appliedAt: l.appliedAt,
    ...(l.approvedAt !== undefined ? { approvedAt: l.approvedAt } : {}),
    ...(l.dueDate !== undefined ? { dueDate: l.dueDate } : {}),
    ...(l.escalatedAt !== undefined ? { escalatedAt: l.escalatedAt } : {}),
    ...(l.closedAt !== undefined ? { closedAt: l.closedAt } : {}),
    ...(l.repaidOnTime !== undefined ? { repaidOnTime: l.repaidOnTime } : {}),
    ...(l.rejectionReason !== undefined ? { rejectionReason: l.rejectionReason } : {}),
  };
}

/** Loan states that count as "the customer already has a loan". */
const OPEN_LOAN_STATUSES = ['pending', 'active', 'arrears'] as const;

// ---------------------------------------------------------------- eligibility

export interface EligibilitySummary {
  customer: { id: string; fullName: string; hasGhanaCard: boolean };
  firstActivityAt: Date | null;
  monthsOfHistory: number;
  susu: { accounts: number; activeAccounts: number; totalDeposited: number };
  savings: { accounts: number; totalBalance: number };
  openLoan: PublicLoan | null;
  bigTierUnlocked: boolean;
}

async function isBigTierUnlocked(customerId: Types.ObjectId): Promise<boolean> {
  const graduated = await LoanModel.findOne({
    customerId,
    tier: 'small',
    status: 'repaid',
    repaidOnTime: true,
  });
  return graduated !== null;
}

export async function eligibilitySummary(customerId: Types.ObjectId): Promise<EligibilitySummary> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const [firstSusu, firstSavings, susuAccounts, savingsAccounts, openLoan, bigTierUnlocked] =
    await Promise.all([
      SusuDepositModel.findOne({ customerId }).sort({ createdAt: 1 }),
      SavingsTxnModel.findOne({ customerId }).sort({ createdAt: 1 }),
      SusuAccountModel.find({ customerId }),
      SavingsAccountModel.find({ customerId }),
      LoanModel.findOne({ customerId, status: { $in: OPEN_LOAN_STATUSES } }),
      isBigTierUnlocked(customerId),
    ]);

  const firsts = [firstSusu?.createdAt, firstSavings?.createdAt].filter(
    (d): d is Date => d !== undefined,
  );
  const firstActivityAt =
    firsts.length > 0 ? new Date(Math.min(...firsts.map((d) => d.getTime()))) : null;
  const monthsOfHistory = firstActivityAt
    ? Math.floor((Date.now() - firstActivityAt.getTime()) / (30.44 * 24 * 60 * 60 * 1000))
    : 0;

  return {
    customer: {
      id: customer._id.toHexString(),
      fullName: customer.fullName,
      hasGhanaCard: customer.identification?.idType === 'ghana-card',
    },
    firstActivityAt,
    monthsOfHistory,
    susu: {
      accounts: susuAccounts.length,
      activeAccounts: susuAccounts.filter((a) => a.status === 'active').length,
      totalDeposited: susuAccounts.reduce((sum, a) => sum + a.totalDeposited, 0),
    },
    savings: {
      accounts: savingsAccounts.length,
      totalBalance: savingsAccounts.reduce((sum, a) => sum + a.balance, 0),
    },
    openLoan: openLoan ? toPublicLoan(openLoan) : null,
    bigTierUnlocked,
  };
}

// ---------------------------------------------------------------- application

export async function applyForLoan(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  principal: number,
  durationMonths: LoanDuration,
  requestId?: string,
): Promise<PublicLoan> {
  const customer = await CustomerModel.findById(customerId);
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }
  if (customer.identification?.idType !== 'ghana-card') {
    throw new AppError(
      'GHANA_CARD_REQUIRED',
      'Loans require a Ghana Card on the customer profile',
      422,
    );
  }

  // One open loan per customer — always refused, no exception paths (rule 7).
  const open = await LoanModel.findOne({ customerId, status: { $in: OPEN_LOAN_STATUSES } });
  if (open) {
    throw new AppError('LOAN_EXISTS', 'Customer already has a pending or active loan', 409);
  }
  // Loans and hire purchase block each other (HP guide, client-confirmed).
  const { HpAgreementModel } = await import('../../models/index.js');
  const { OPEN_HP_STATUSES } = await import('../hire-purchase/hp.service.js');
  const openHp = await HpAgreementModel.exists({
    customerId,
    status: { $in: OPEN_HP_STATUSES },
  });
  if (openHp) {
    throw new AppError(
      'HP_EXISTS',
      'Customer has an open hire purchase agreement — loans and HP block each other',
      409,
    );
  }

  const config = await getLoanConfig();
  const tier = tierFor(principal, config.tiers);
  if (!tier) {
    throw new AppError(
      'PRINCIPAL_OUT_OF_RANGE',
      `Principal must be between ${formatGhs(config.tiers.smallMin)} and ${formatGhs(config.tiers.bigMax)}`,
      422,
    );
  }
  if (tier === 'big' && !(await isBigTierUnlocked(customerId))) {
    throw new AppError(
      'BIG_TIER_LOCKED',
      'The big tier requires a previous small loan repaid on time',
      422,
    );
  }

  const ratePercent = config.rates[durationMonths];
  const interestAmount = computeInterest(principal, ratePercent);
  const loan = await LoanModel.create({
    customerId,
    tier,
    principal,
    durationMonths,
    ratePercent,
    interestAmount,
    totalDue: principal + interestAmount,
    appliedAt: new Date(),
  });

  await audit({
    actorId: actor.sub,
    action: 'loan.apply',
    entityType: 'loan',
    entityId: loan._id,
    amountAfter: loan.totalDue,
    after: { principal, durationMonths, tier, ratePercent },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('loan.applied', {
    id: loan._id.toHexString(),
    customerId: customerId.toHexString(),
    customerName: customer.fullName,
    principal,
    tier,
  });
  return toPublicLoan(loan);
}

// ---------------------------------------------------------------- approval

export async function approveLoan(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  requestId?: string,
): Promise<PublicLoan> {
  const pre = await LoanModel.findById(loanId);
  if (!pre) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (pre.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Loan is ${pre.status}, not pending`, 409);
  }
  const customer = await CustomerModel.findById(pre.customerId);

  const config = await getLoanConfig();
  const now = new Date();
  const ratePercent = config.rates[pre.durationMonths];
  const interestAmount = computeInterest(pre.principal, ratePercent);
  const totalDue = pre.principal + interestAmount;
  const dueDate = addMonthsClamped(now, pre.durationMonths);
  const schedule = buildSchedule(totalDue, pre.durationMonths, now);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await LoanModel.updateOne(
        { _id: loanId, status: 'pending' },
        {
          $set: {
            status: 'active',
            ratePercent,
            interestAmount,
            totalDue,
            approvedById: new Types.ObjectId(actor.sub),
            approvedAt: now,
            disbursedAt: now,
            dueDate,
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('NOT_PENDING', 'Loan is no longer pending', 409);
      }
      await LoanScheduleModel.create(
        schedule.map((line) => ({
          loanId,
          customerId: pre.customerId,
          installmentNumber: line.installmentNumber,
          dueDate: line.dueDate,
          amountDue: line.amountDue,
        })),
        { session, ordered: true },
      );
      await audit(
        {
          actorId: actor.sub,
          action: 'loan.approve',
          entityType: 'loan',
          entityId: loanId,
          amountAfter: totalDue,
          after: { ratePercent, dueDate: dueDate.toISOString() },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const loan = await LoanModel.findById(loanId);
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);

  if (customer) {
    const monthly = schedule[0]?.amountDue ?? 0;
    await enqueueSms({
      to: customer.phone,
      template: 'loan-approved',
      message:
        `Yadah: your loan of ${formatGhs(loan.principal)} is approved. ` +
        `Total due: ${formatGhs(totalDue)} by ${dueDate.toISOString().slice(0, 10)}. ` +
        `Monthly instalment: ${formatGhs(monthly)}.`,
      relatedEntityType: 'loan',
      relatedEntityId: loanId,
    });
  }
  emitAdminEvent('loan.approved', {
    id: loanId.toHexString(),
    customerId: pre.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    principal: pre.principal,
    totalDue,
  });
  return toPublicLoan(loan);
}

export async function rejectLoan(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  reason: string,
  requestId?: string,
): Promise<PublicLoan> {
  const loan = await LoanModel.findById(loanId);
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (loan.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Loan is ${loan.status}, not pending`, 409);
  }
  loan.status = 'rejected';
  loan.rejectionReason = reason;
  loan.closedAt = new Date();
  await loan.save();

  await audit({
    actorId: actor.sub,
    action: 'loan.reject',
    entityType: 'loan',
    entityId: loan._id,
    after: { reason },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('loan.rejected', { id: loan._id.toHexString(), reason });
  return toPublicLoan(loan);
}

// ---------------------------------------------------------------- listing

export async function listLoans(
  query: ListLoansQuery,
): Promise<{ items: PublicLoan[]; page: number; limit: number; total: number }> {
  const filter: Record<string, unknown> = {};
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    filter.customerId = { $in: await fuzzyCustomerIds(query.search) };
  }

  const [loans, total] = await Promise.all([
    LoanModel.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    LoanModel.countDocuments(filter),
  ]);
  const unique = [...new Set(loans.map((l) => l.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: loans.map((l) => ({
      ...toPublicLoan(l),
      customerName: names.get(l.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

export interface LoanDetail {
  loan: PublicLoan;
  schedule: {
    installmentNumber: number;
    dueDate: Date;
    amountDue: number;
    amountPaid: number;
    status: string;
  }[];
  repayments: {
    id: string;
    amount: number;
    source: string;
    susuAccountId?: string;
    recordedById: string;
    createdAt: Date;
  }[];
}

export async function getLoan(loanId: Types.ObjectId): Promise<LoanDetail> {
  const loan = await LoanModel.findById(loanId);
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  const [schedule, repayments] = await Promise.all([
    LoanScheduleModel.find({ loanId }).sort({ installmentNumber: 1 }),
    RepaymentModel.find({ loanId }).sort({ createdAt: -1 }),
  ]);
  return {
    loan: toPublicLoan(loan),
    schedule: schedule.map((s) => ({
      installmentNumber: s.installmentNumber,
      dueDate: s.dueDate,
      amountDue: s.amountDue,
      amountPaid: s.amountPaid,
      status: s.status,
    })),
    repayments: repayments.map((r) => ({
      id: r._id.toHexString(),
      amount: r.amount,
      source: r.source,
      ...(r.susuAccountId ? { susuAccountId: r.susuAccountId.toHexString() } : {}),
      recordedById: r.recordedById.toHexString(),
      createdAt: r.createdAt,
    })),
  };
}

// ---------------------------------------------------------------- repayments

export interface RepaymentResult {
  repayment: { id: string; amount: number; source: string };
  loan: PublicLoan;
  replayed: boolean;
  /** Present when the repayment came from a susu closure. */
  susuClosure?: {
    accountId: string;
    commission: number;
    payout: number;
    /** What actually hit the loan (payout capped at the remaining balance). */
    applied?: number;
    /** Left over — pending withdrawal or credited to savings per excessTo. */
    excess?: number;
  };
}

async function replayIfExists(idempotencyKey: string): Promise<RepaymentResult | null> {
  const existing = await RepaymentModel.findOne({ idempotencyKey });
  if (!existing) return null;
  const loan = await LoanModel.findById(existing.loanId);
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  return {
    repayment: { id: existing._id.toHexString(), amount: existing.amount, source: existing.source },
    loan: toPublicLoan(loan),
    replayed: true,
  };
}

/**
 * Core repayment writer — runs INSIDE the caller's transaction. Applies
 * amount to the loan + schedule, flips to repaid when settled.
 */
export async function applyRepaymentInTxn(
  actor: AccessTokenPayload,
  loan: Loan,
  amount: number,
  source: 'cash' | 'susu-closure' | 'transfer',
  channel: Channel,
  idempotencyKey: string,
  session: mongoose.ClientSession,
  susuAccountId?: Types.ObjectId,
  requestId?: string,
): Promise<Repayment> {
  const remaining = loan.totalDue - loan.totalRepaid;
  if (amount > remaining) {
    throw new AppError(
      'EXCEEDS_BALANCE',
      `Amount exceeds the remaining balance (${formatGhs(remaining)})`,
      422,
      { remaining, amount },
    );
  }

  const fullyRepaid = amount === remaining;
  const now = new Date();
  const upd = await LoanModel.updateOne(
    { _id: loan._id, status: loan.status, totalRepaid: loan.totalRepaid },
    {
      $inc: { totalRepaid: amount },
      ...(fullyRepaid
        ? {
            $set: {
              status: 'repaid',
              closedAt: now,
              frozen: false,
              repaidOnTime: loan.dueDate !== undefined && now.getTime() <= loan.dueDate.getTime(),
            },
          }
        : {}),
    },
    { session },
  );
  if (upd.modifiedCount !== 1) {
    throw new AppError('CONFLICT', 'Loan was updated concurrently — retry', 409);
  }

  // Allocate to instalments, oldest first.
  const schedule = await LoanScheduleModel.find({ loanId: loan._id })
    .sort({ installmentNumber: 1 })
    .session(session);
  const additions = allocateRepayment(
    schedule.map((s) => ({ amountDue: s.amountDue, amountPaid: s.amountPaid })),
    amount,
  );
  for (const [i, line] of schedule.entries()) {
    const add = additions[i] ?? 0;
    if (add === 0) continue;
    const paid = line.amountPaid + add;
    await LoanScheduleModel.updateOne(
      { _id: line._id },
      { $set: { amountPaid: paid, status: paid >= line.amountDue ? 'paid' : 'partial' } },
      { session },
    );
  }

  const [repayment] = await RepaymentModel.create(
    [
      {
        loanId: loan._id,
        customerId: loan.customerId,
        amount,
        source,
        channel,
        ...(susuAccountId ? { susuAccountId } : {}),
        recordedById: new Types.ObjectId(actor.sub),
        idempotencyKey,
      },
    ],
    { session },
  );

  await audit(
    {
      actorId: actor.sub,
      action: 'loan.repayment',
      entityType: 'loan',
      entityId: loan._id,
      amountBefore: loan.totalRepaid,
      amountAfter: loan.totalRepaid + amount,
      after: {
        source,
        fullyRepaid,
        ...(susuAccountId ? { susuAccountId: susuAccountId.toHexString() } : {}),
      },
      ...(requestId !== undefined ? { requestId } : {}),
    },
    session,
  );
  return repayment as Repayment;
}

async function loadOpenLoanForRepayment(
  loanId: Types.ObjectId,
): Promise<{ loan: Loan; customer: Customer | null }> {
  const loan = await LoanModel.findById(loanId);
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (loan.status !== 'active' && loan.status !== 'arrears') {
    throw new AppError('LOAN_NOT_OPEN', `Loan is ${loan.status} — nothing to repay`, 422);
  }
  const customer = await CustomerModel.findById(loan.customerId);
  return { loan, customer };
}

async function notifyRepayment(
  customer: Customer | null,
  loanId: Types.ObjectId,
  amount: number,
  loanAfter: Loan,
): Promise<void> {
  if (customer) {
    const settled = loanAfter.status === 'repaid';
    await enqueueSms({
      to: customer.phone,
      template: 'loan-repayment',
      message: settled
        ? `Yadah: ${formatGhs(amount)} received. Your loan is fully repaid. Thank you!`
        : `Yadah: ${formatGhs(amount)} received on your loan. Balance: ${formatGhs(loanAfter.totalDue - loanAfter.totalRepaid)}.`,
      relatedEntityType: 'loan',
      relatedEntityId: loanId,
    });
  }
  emitAdminEvent('loan.repayment', {
    id: loanId.toHexString(),
    customerId: loanAfter.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    amount,
    remaining: loanAfter.totalDue - loanAfter.totalRepaid,
    repaid: loanAfter.status === 'repaid',
  });
}

export async function repayCash(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  amount: number,
  idempotencyKey: string,
  channel: Channel,
  requestId?: string,
): Promise<RepaymentResult> {
  const replayed = await replayIfExists(idempotencyKey);
  if (replayed) return replayed;

  const { loan, customer } = await loadOpenLoanForRepayment(loanId);
  const session = await mongoose.startSession();
  let repayment!: Repayment;
  try {
    await session.withTransaction(async () => {
      repayment = await applyRepaymentInTxn(
        actor,
        loan,
        amount,
        'cash',
        channel,
        idempotencyKey,
        session,
        undefined,
        requestId,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await LoanModel.findById(loanId);
  if (!after) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  await notifyRepayment(customer, loanId, amount, after);
  return {
    repayment: { id: repayment._id.toHexString(), amount, source: 'cash' },
    loan: toPublicLoan(after),
    replayed: false,
  };
}

/**
 * Repayment by closing a susu account: one transaction closes the account
 * (normal commission math) and applies the payout to the loan. All-or-nothing
 * across both modules (rule 2). Client-confirmed excess handling: when the
 * payout exceeds the remaining loan balance, the excess stays in the susu
 * account pending withdrawal, or — on customer request — goes to savings.
 */
export async function repayViaSusuClosure(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  susuAccountId: Types.ObjectId,
  idempotencyKey: string,
  excessTo: 'pending-withdrawal' | 'savings' = 'pending-withdrawal',
  requestId?: string,
): Promise<RepaymentResult> {
  const replayed = await replayIfExists(idempotencyKey);
  if (replayed) return replayed;

  const { loan, customer } = await loadOpenLoanForRepayment(loanId);
  const susuPre = await SusuAccountModel.findById(susuAccountId);
  if (!susuPre) throw new AppError('NOT_FOUND', 'Susu account not found', 404);
  if (!susuPre.customerId.equals(loan.customerId)) {
    throw new AppError('CUSTOMER_MISMATCH', 'Susu account belongs to a different customer', 422);
  }
  if (susuPre.status === 'closed' || susuPre.status === 'pending-payout') {
    throw new AppError('ALREADY_CLOSED', 'Susu account is already stopped', 409);
  }

  // Excess-to-savings needs an active savings account up front.
  let savingsTarget: mongoose.HydratedDocument<SavingsAccount> | null = null;
  if (excessTo === 'savings') {
    savingsTarget = await SavingsAccountModel.findOne({
      customerId: loan.customerId,
      status: 'active',
    });
    if (!savingsTarget) {
      throw new AppError(
        'NO_SAVINGS_ACCOUNT',
        'Customer has no active savings account for the excess',
        422,
      );
    }
  }

  const session = await mongoose.startSession();
  let repayment!: Repayment;
  let closure!: { commission: number; payout: number; applied: number; excess: number };
  try {
    await session.withTransaction(async () => {
      const account = await SusuAccountModel.findOne({
        _id: susuAccountId,
        status: { $in: ['active', 'completed'] },
      }).session(session);
      if (!account) throw new AppError('ALREADY_CLOSED', 'Susu account is already stopped', 409);

      const { commission, payout } = computeClosure(account.totalDeposited, account.dailyAmount);
      if (payout < 1) {
        throw new AppError('NO_PAYOUT', 'Susu closure yields no payout to apply', 422);
      }
      const remaining = loan.totalDue - loan.totalRepaid;
      const applied = Math.min(payout, remaining);
      const excess = payout - applied;
      closure = { commission, payout, applied, excess };

      repayment = await applyRepaymentInTxn(
        actor,
        loan,
        applied,
        'susu-closure',
        'cash',
        idempotencyKey,
        session,
        susuAccountId,
        requestId,
      );

      const now = new Date();
      const keepsPending = excess > 0 && excessTo === 'pending-withdrawal';
      const upd = await SusuAccountModel.updateOne(
        { _id: account._id, status: account.status, totalDeposited: account.totalDeposited },
        {
          $set: {
            status: keepsPending ? 'pending-payout' : 'closed',
            commissionAmount: commission,
            payoutAmount: payout,
            payoutRemaining: keepsPending ? excess : 0,
            ...(keepsPending ? {} : { closedAt: now, closedById: new Types.ObjectId(actor.sub) }),
          },
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Susu account was updated concurrently — retry', 409);
      }

      // Payout record for the loan portion.
      await SusuPayoutModel.create(
        [
          {
            accountId: account._id,
            customerId: loan.customerId,
            amount: applied,
            destination: 'loan',
            destinationId: loanId,
            recordedById: new Types.ObjectId(actor.sub),
          },
        ],
        { session },
      );

      // Excess straight into savings, in the same transaction.
      if (excess > 0 && excessTo === 'savings' && savingsTarget) {
        const savUpd = await SavingsAccountModel.updateOne(
          { _id: savingsTarget._id, status: 'active', balance: savingsTarget.balance },
          { $inc: { balance: excess } },
          { session },
        );
        if (savUpd.modifiedCount !== 1) {
          throw new AppError('CONFLICT', 'Savings account was updated concurrently — retry', 409);
        }
        await SavingsTxnModel.create(
          [
            {
              accountId: savingsTarget._id,
              customerId: loan.customerId,
              type: 'deposit',
              amount: excess,
              balanceAfter: savingsTarget.balance + excess,
              channel: 'transfer',
              accraDay: accraDay(),
              recordedById: new Types.ObjectId(actor.sub),
            },
          ],
          { session },
        );
        await SusuPayoutModel.create(
          [
            {
              accountId: account._id,
              customerId: loan.customerId,
              amount: excess,
              destination: 'savings',
              destinationId: savingsTarget._id,
              recordedById: new Types.ObjectId(actor.sub),
            },
          ],
          { session },
        );
        await audit(
          {
            actorId: actor.sub,
            action: 'savings.deposit.record',
            entityType: 'savings-account',
            entityId: savingsTarget._id,
            amountBefore: savingsTarget.balance,
            amountAfter: savingsTarget.balance + excess,
            after: { source: 'susu-excess', susuAccountId: susuAccountId.toHexString() },
            ...(requestId !== undefined ? { requestId } : {}),
          },
          session,
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
          after: {
            commission,
            payout,
            appliedToLoan: loanId.toHexString(),
            excess,
            excessTo: excess > 0 ? excessTo : null,
          },
          ...(requestId !== undefined ? { requestId } : {}),
        },
        session,
      );
    });
  } finally {
    await session.endSession();
  }

  const after = await LoanModel.findById(loanId);
  if (!after) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  await notifyRepayment(customer, loanId, closure.applied, after);
  if (closure.excess > 0 && customer) {
    await enqueueSms({
      to: customer.phone,
      template: 'susu-excess',
      message:
        excessTo === 'savings'
          ? `Yadah: ${formatGhs(closure.excess)} left over from your susu was credited to your savings account.`
          : `Yadah: ${formatGhs(closure.excess)} left over from your susu is waiting for you at the office.`,
      relatedEntityType: 'susu-account',
      relatedEntityId: susuAccountId,
    });
  }
  emitAdminEvent('susu.account.closed', {
    id: susuAccountId.toHexString(),
    customerId: loan.customerId.toHexString(),
    customerName: customer?.fullName ?? '',
    payout: closure.payout,
    commission: closure.commission,
    appliedToLoan: loanId.toHexString(),
    excess: closure.excess,
  });
  return {
    repayment: { id: repayment._id.toHexString(), amount: closure.applied, source: 'susu-closure' },
    loan: toPublicLoan(after),
    replayed: false,
    susuClosure: { accountId: susuAccountId.toHexString(), ...closure },
  };
}
