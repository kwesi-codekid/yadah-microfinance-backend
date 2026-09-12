import mongoose, { Types } from 'mongoose';
import { nextAccountNumber } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import type { CorrectionPlan, CorrectionPreparer } from '../../lib/corrections.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { enqueueSms } from '../../lib/sms.js';
import { fuzzyCustomerIds } from '../../lib/fuzzy.js';
import { hasIdDocument, idDocumentRequired, missingIdParts } from '../../lib/id-document.js';
import { buildReceiptPdf, receiptNumber, type ReceiptLine } from '../../lib/receipt-pdf.js';
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
  UserModel,
  type Customer,
  type Loan,
  type Repayment,
  type SavingsAccount,
} from '../../models/index.js';
import { accraDay, createdAtFilter } from '../../lib/time.js';
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
import { computeClosure, susuBalance } from '../../domain/susu.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { NOT_TRASHED, requireDeletedAt, type Channel } from '../../models/shared.js';
import type { ListLoansQuery, LoanTrashQuery, PutConfigBody } from './loans.schemas.js';

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
  /** LN + YYMM + sequence. Absent on loans predating the numbering scheme. */
  accountNumber?: string;
  customerId: string;
  customerName?: string;
  /** Who stands behind it. Absent on loans written before guarantors existed. */
  guarantorId?: string;
  /** The guarantor as they were when the application was signed. */
  guarantor?: {
    fullName: string;
    phone: string;
    idType?: string;
    idNumber?: string;
  };
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
  disbursedAt?: Date;
  dueDate?: Date;
  escalatedAt?: Date;
  closedAt?: Date;
  repaidOnTime?: boolean;
  rejectionReason?: string;
  /** A picture of the customer's signature on the application. */
  signatureUrl?: string;
}

export function toPublicLoan(l: Loan): PublicLoan {
  return {
    id: l._id.toHexString(),
    ...(l.accountNumber !== undefined ? { accountNumber: l.accountNumber } : {}),
    customerId: l.customerId.toHexString(),
    ...(l.guarantorId !== undefined ? { guarantorId: l.guarantorId.toHexString() } : {}),
    ...(l.guarantorSnapshot !== undefined ? { guarantor: l.guarantorSnapshot } : {}),
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
    ...(l.disbursedAt !== undefined ? { disbursedAt: l.disbursedAt } : {}),
    ...(l.dueDate !== undefined ? { dueDate: l.dueDate } : {}),
    ...(l.escalatedAt !== undefined ? { escalatedAt: l.escalatedAt } : {}),
    ...(l.closedAt !== undefined ? { closedAt: l.closedAt } : {}),
    ...(l.repaidOnTime !== undefined ? { repaidOnTime: l.repaidOnTime } : {}),
    ...(l.rejectionReason !== undefined ? { rejectionReason: l.rejectionReason } : {}),
    ...(l.signatureUrl !== undefined ? { signatureUrl: l.signatureUrl } : {}),
  };
}

/** Flat spreadsheet row for the loans listing export (csv/xlsx). */
export function toLoanExportRow(item: PublicLoan): Record<string, unknown> {
  return {
    id: item.id,
    customerName: item.customerName ?? '',
    // Appended at the end would read oddly beside the borrower; the guarantor
    // belongs next to the person they are standing behind.
    guarantorName: item.guarantor?.fullName ?? '',
    guarantorPhone: item.guarantor?.phone ?? '',
    tier: item.tier,
    principal: item.principal,
    durationMonths: item.durationMonths,
    ratePercent: item.ratePercent,
    interestAmount: item.interestAmount,
    totalDue: item.totalDue,
    totalRepaid: item.totalRepaid,
    remaining: item.remaining,
    status: item.status,
    frozen: item.frozen,
    appliedAt: item.appliedAt,
    disbursedAt: item.disbursedAt ?? null,
    dueDate: item.dueDate ?? null,
  };
}

/** Loan states that count as "the customer already has a loan". */
const OPEN_LOAN_STATUSES = ['pending', 'active', 'arrears'] as const;

// ---------------------------------------------------------------- eligibility

export interface EligibilitySummary {
  customer: {
    id: string;
    fullName: string;
    /** Informational only — any ID type may back a loan. */
    hasGhanaCard: boolean;
    /** An ID type and number are recorded. */
    hasId: boolean;
    /** Both sides of the ID are photographed. */
    hasIdDocument: boolean;
  };
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
    ...NOT_TRASHED,
  });
  return graduated !== null;
}

export async function eligibilitySummary(customerId: Types.ObjectId): Promise<EligibilitySummary> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  const [firstSusu, firstSavings, susuAccounts, savingsAccounts, openLoan, bigTierUnlocked] =
    await Promise.all([
      SusuDepositModel.findOne({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
      SavingsTxnModel.findOne({ customerId, ...NOT_TRASHED }).sort({ createdAt: 1 }),
      SusuAccountModel.find({ customerId, ...NOT_TRASHED }),
      SavingsAccountModel.find({ customerId, ...NOT_TRASHED }),
      LoanModel.findOne({ customerId, status: { $in: OPEN_LOAN_STATUSES }, ...NOT_TRASHED }),
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
      // Kept for the screens that still read it, but no longer a condition of
      // lending: any ID type is accepted.
      hasGhanaCard: customer.identification?.idType === 'ghana-card',
      hasId: Boolean(customer.identification?.idNumber),
      hasIdDocument: hasIdDocument(customer),
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

/**
 * The guarantor: another registered customer who stands behind the loan.
 *
 * Held to the same identification bar as the borrower — an ID recorded and both
 * sides of it photographed — because a guarantor nobody can identify is not a
 * guarantor. Any of the four ID types will do; which document it is has never
 * been the point.
 *
 * Returns the snapshot the loan stores, so the undertaking keeps the details it
 * was signed against even if the guarantor later changes them.
 */
async function resolveGuarantor(
  borrowerId: Types.ObjectId,
  guarantorId: Types.ObjectId,
): Promise<NonNullable<Loan['guarantorSnapshot']>> {
  if (guarantorId.equals(borrowerId)) {
    throw new AppError(
      'GUARANTOR_IS_BORROWER',
      'A customer cannot guarantee their own loan — choose somebody else',
      422,
    );
  }
  const guarantor = await CustomerModel.findOne({ _id: guarantorId, ...NOT_TRASHED });
  if (!guarantor) {
    throw new AppError('GUARANTOR_NOT_FOUND', 'That guarantor is not on our books', 404);
  }
  if (guarantor.status !== 'active') {
    throw new AppError(
      'GUARANTOR_INACTIVE',
      `${guarantor.fullName} is deactivated and cannot stand behind a loan`,
      422,
    );
  }
  const missing = missingIdParts(guarantor);
  if (missing.length > 0) {
    throw new AppError(
      'GUARANTOR_ID_INCOMPLETE',
      `${guarantor.fullName} cannot guarantee a loan yet — ${missing.join(' and ')} ` +
        'is missing from their profile',
      422,
      { guarantorId: guarantorId.toHexString(), missing },
    );
  }
  return {
    fullName: guarantor.fullName,
    phone: guarantor.phone,
    ...(guarantor.identification?.idType !== undefined
      ? { idType: guarantor.identification.idType }
      : {}),
    ...(guarantor.identification?.idNumber !== undefined
      ? { idNumber: guarantor.identification.idNumber }
      : {}),
  };
}

export async function applyForLoan(
  actor: AccessTokenPayload,
  customerId: Types.ObjectId,
  principal: number,
  durationMonths: LoanDuration,
  guarantorId: Types.ObjectId,
  signatureUrl?: string,
  requestId?: string,
): Promise<PublicLoan> {
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }
  // Any of the four ID types is accepted (client decision, 12 Sep 2026 — this
  // used to demand a Ghana Card). What a loan turns on is that the borrower is
  // identified at all: an ID recorded, and both sides of it photographed. The
  // customer service refuses to remove either while this loan stays open.
  if (!customer.identification?.idNumber) {
    throw new AppError(
      'ID_REQUIRED',
      'No ID on the customer profile — record the ID type and number first',
      422,
    );
  }
  if (!hasIdDocument(customer)) throw idDocumentRequired();

  // One open loan per customer — always refused, no exception paths (rule 7).
  const open = await LoanModel.findOne({
    customerId,
    status: { $in: OPEN_LOAN_STATUSES },
    ...NOT_TRASHED,
  });
  if (open) {
    throw new AppError('LOAN_EXISTS', 'Customer already has a pending or active loan', 409);
  }
  // Loans and hire purchase block each other (HP guide, client-confirmed).
  const { HpAgreementModel } = await import('../../models/index.js');
  const { OPEN_HP_STATUSES } = await import('../hire-purchase/hp.service.js');
  const openHp = await HpAgreementModel.exists({
    customerId,
    status: { $in: OPEN_HP_STATUSES },
    ...NOT_TRASHED,
  });
  if (openHp) {
    throw new AppError(
      'HP_EXISTS',
      'Customer has an open hire purchase agreement — loans and HP block each other',
      409,
    );
  }

  // Checked before the numbers are worked out: a loan with no valid guarantor
  // is not going to be written, and the counter should hear about the guarantor
  // rather than about the tier.
  const guarantorSnapshot = await resolveGuarantor(customerId, guarantorId);

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
    accountNumber: await nextAccountNumber('LN'),
    customerId,
    guarantorId,
    guarantorSnapshot,
    tier,
    principal,
    durationMonths,
    ratePercent,
    interestAmount,
    totalDue: principal + interestAmount,
    appliedAt: new Date(),
    ...(signatureUrl !== undefined ? { signatureUrl } : {}),
  });

  await audit({
    actorId: actor.sub,
    action: 'loan.apply',
    entityType: 'loan',
    entityId: loan._id,
    amountAfter: loan.totalDue,
    after: {
      principal,
      durationMonths,
      tier,
      ratePercent,
      guarantorId: guarantorId.toHexString(),
      guarantorName: guarantorSnapshot.fullName,
    },
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
  const pre = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (pre.status !== 'pending') {
    throw new AppError('NOT_PENDING', `Loan is ${pre.status}, not pending`, 409);
  }
  const customer = await CustomerModel.findById(pre.customerId);
  // Money leaves here, so the ID rule is checked again — an application that
  // predates it, or one restored from the trash, must not slip through.
  if (customer && !hasIdDocument(customer)) throw idDocumentRequired();

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
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
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
  const filter: Record<string, unknown> = { ...NOT_TRASHED };
  if (query.customerId) filter.customerId = query.customerId;
  if (query.status) filter.status = query.status;
  if (query.search !== undefined) {
    filter.customerId = { $in: await fuzzyCustomerIds(query.search) };
  }
  const dateFilter = createdAtFilter(query.from, query.to);
  if (dateFilter) filter.createdAt = dateFilter;

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
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
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
      channel: r.channel,
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
    { _id: loan._id, status: loan.status, totalRepaid: loan.totalRepaid, ...NOT_TRASHED },
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
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
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

// ---------------------------------------------------------------- corrections

/**
 * Correcting the amount on a cash repayment, for the corrections module (see
 * lib/corrections.ts): outright for the office, or after a teller asked and
 * the office approved.
 *
 * Only the newest repayment qualifies: the schedule is filled oldest
 * instalment first, so its state depends only on the total repaid, and the
 * newest is the one whose amount can move without a later one having been
 * built on it. The schedule is rebuilt from the new total rather than
 * adjusted, which is the same arithmetic the original allocation did. A
 * repayment that settled the loan and no longer does reopens it as active —
 * the escalation worker decides arrears on its own schedule, from the due
 * date, and needs no guess here. Repayments paid from a susu closure or a
 * transfer, and Paystack charges, are not data entry and cannot be corrected.
 */
export const prepareRepaymentCorrection: CorrectionPreparer = async (loanId, repaymentId) => {
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  const repayment = await RepaymentModel.findOne({ _id: repaymentId, loanId });
  if (!repayment) throw new AppError('NOT_FOUND', 'Repayment not found', 404);
  const newest = await RepaymentModel.findOne({ loanId }).sort({ createdAt: -1, _id: -1 });
  const isNewest = newest?._id.equals(repayment._id) ?? false;
  // What the loan still owed before this repayment landed.
  const remainingBefore = loan.totalDue - (loan.totalRepaid - repayment.amount);

  const plan = (amount: number): CorrectionPlan => {
    if (repayment.source !== 'cash') {
      throw new AppError(
        'CANNOT_CORRECT',
        `A repayment paid ${repayment.source === 'susu-closure' ? 'by closing a susu account' : 'by transfer'} cannot be changed on its own`,
        422,
      );
    }
    if (repayment.channel === 'paystack') {
      throw new AppError(
        'CANNOT_CORRECT',
        'This was paid through Paystack, so the amount is what was charged',
        422,
      );
    }
    if (loan.status !== 'active' && loan.status !== 'arrears' && loan.status !== 'repaid') {
      throw new AppError('CANNOT_CORRECT', `Loan is ${loan.status} — nothing has been repaid`, 422);
    }
    if (!isNewest) {
      throw new AppError(
        'CANNOT_CORRECT',
        'Only the most recent repayment can be changed — correct from the end',
        422,
      );
    }
    if (amount > remainingBefore) {
      throw new AppError(
        'EXCEEDS_BALANCE',
        `Amount exceeds the remaining balance (${formatGhs(remainingBefore)})`,
        422,
        { remaining: remainingBefore, amount },
      );
    }
    return {};
  };

  return {
    kind: 'loan-repayment',
    targetId: loanId,
    txnId: repaymentId,
    customerId: repayment.customerId,
    amount: repayment.amount,
    plan,
    apply: async (session, actor, amount, requestId, origin) => {
      plan(amount);
      const delta = amount - repayment.amount;
      const totalRepaid = loan.totalRepaid + delta;
      const settles = amount === remainingBefore;
      const wasRepaid = loan.status === 'repaid';
      const now = new Date();
      const upd = await LoanModel.updateOne(
        { _id: loanId, status: loan.status, totalRepaid: loan.totalRepaid, ...NOT_TRASHED },
        {
          $inc: { totalRepaid: delta },
          ...(settles && !wasRepaid
            ? {
                $set: {
                  status: 'repaid',
                  closedAt: now,
                  frozen: false,
                  repaidOnTime:
                    loan.dueDate !== undefined && now.getTime() <= loan.dueDate.getTime(),
                },
              }
            : {}),
          ...(!settles && wasRepaid
            ? { $set: { status: 'active' }, $unset: { closedAt: '', repaidOnTime: '' } }
            : {}),
        },
        { session },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Loan was updated concurrently — retry', 409);
      }

      // The schedule as the new total fills it, oldest instalment first.
      const schedule = await LoanScheduleModel.find({ loanId })
        .sort({ installmentNumber: 1 })
        .session(session);
      const filled = allocateRepayment(
        schedule.map((line) => ({ amountDue: line.amountDue, amountPaid: 0 })),
        totalRepaid,
      );
      for (const [i, line] of schedule.entries()) {
        const paid = filled[i] ?? 0;
        const status =
          paid >= line.amountDue
            ? 'paid'
            : paid > 0
              ? 'partial'
              : line.status === 'overdue'
                ? 'overdue'
                : 'pending';
        if (paid === line.amountPaid && status === line.status) continue;
        await LoanScheduleModel.updateOne(
          { _id: line._id },
          { $set: { amountPaid: paid, status } },
          { session },
        );
      }

      const repUpd = await RepaymentModel.updateOne(
        { _id: repaymentId, amount: repayment.amount },
        { $set: { amount } },
        { session },
      );
      if (repUpd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Repayment changed concurrently — retry', 409);
      }
      await audit(
        {
          actorId: actor.sub,
          action: 'loan.repayment.update',
          entityType: 'repayment',
          entityId: repaymentId,
          amountBefore: loan.totalRepaid,
          amountAfter: totalRepaid,
          before: { amount: repayment.amount },
          after: {
            amount,
            settles,
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
      const [afterLoan, afterRepayment] = await Promise.all([
        LoanModel.findById(loanId),
        RepaymentModel.findById(repaymentId),
      ]);
      if (!afterLoan || !afterRepayment) {
        throw new AppError('NOT_FOUND', 'Repayment not found', 404);
      }
      return {
        target: toPublicLoan(afterLoan),
        txn: {
          id: afterRepayment._id.toHexString(),
          amount: afterRepayment.amount,
          source: afterRepayment.source,
          channel: afterRepayment.channel,
          recordedById: afterRepayment.recordedById.toHexString(),
          createdAt: afterRepayment.createdAt,
        },
      };
    },
  };
};

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

      // Balance, not the running deposit total — partial withdrawals have
      // already taken their share out of the account.
      const balance = susuBalance(account.totalDeposited, account.withdrawnAmount);
      const { commission, payout } = computeClosure(balance, account.dailyAmount);
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
        {
          _id: account._id,
          status: account.status,
          totalDeposited: account.totalDeposited,
          withdrawnAmount: account.withdrawnAmount,
        },
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

      // Payout record for the loan portion. This is the row that stopped the
      // account, so this is the row that carries the closing commission — the
      // excess leg below must not charge it a second time.
      await SusuPayoutModel.create(
        [
          {
            accountId: account._id,
            customerId: loan.customerId,
            amount: applied,
            destination: 'loan',
            destinationId: loanId,
            commissionAmount: commission,
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
              commissionAmount: 0,
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

// ---------------------------------------------------------------- trash

export interface TrashedLoan extends PublicLoan {
  deletedAt: Date;
  deletedById?: string;
  deleteReason?: string;
}

function toTrashedLoan(l: Loan): TrashedLoan {
  return {
    ...toPublicLoan(l),
    deletedAt: requireDeletedAt(l.deletedAt),
    ...(l.deletedById !== undefined ? { deletedById: l.deletedById.toHexString() } : {}),
    ...(l.deleteReason !== undefined ? { deleteReason: l.deleteReason } : {}),
  };
}

/**
 * Soft delete. Only applications that never moved money — pending or
 * rejected — can go to the trash; everything else is ledger history.
 */
export async function trashLoan(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  reason?: string,
  requestId?: string,
): Promise<TrashedLoan> {
  const pre = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
  if (!pre) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (pre.status !== 'pending' && pre.status !== 'rejected') {
    throw new AppError(
      'CANNOT_TRASH',
      'Only pending or rejected loan applications can be moved to the trash',
      422,
      { status: pre.status },
    );
  }

  const now = new Date();
  const loan = await LoanModel.findOneAndUpdate(
    { _id: loanId, status: pre.status, ...NOT_TRASHED },
    {
      $set: {
        deletedAt: now,
        deletedById: new Types.ObjectId(actor.sub),
        ...(reason !== undefined ? { deleteReason: reason } : {}),
      },
    },
    { returnDocument: 'after' },
  );
  if (!loan) throw new AppError('CONFLICT', 'Loan was updated concurrently — retry', 409);

  await audit({
    actorId: actor.sub,
    action: 'loan.trash',
    entityType: 'loan',
    entityId: pre._id,
    before: { status: pre.status, deletedAt: null },
    after: {
      status: loan.status,
      deletedAt: now.toISOString(),
      ...(reason !== undefined ? { reason } : {}),
    },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('loan.trashed', {
    id: pre._id.toHexString(),
    customerId: pre.customerId.toHexString(),
    status: pre.status,
    principal: pre.principal,
  });
  return toTrashedLoan(loan);
}

export async function restoreLoan(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  requestId?: string,
): Promise<PublicLoan> {
  const pre = await LoanModel.findById(loanId);
  if (!pre) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (!pre.deletedAt) throw new AppError('NOT_TRASHED', 'Loan is not in the trash', 409);

  // A restored pending application re-enters the open set, so the one-open-
  // loan rule must still hold. Rejected loans restore unconditionally.
  if (pre.status === 'pending') {
    const open = await LoanModel.findOne({
      customerId: pre.customerId,
      status: { $in: OPEN_LOAN_STATUSES },
      ...NOT_TRASHED,
    });
    if (open) {
      throw new AppError('LOAN_EXISTS', 'Customer already has a pending or active loan', 409);
    }
    // The scans may have been cleared while the application sat in the trash.
    const customer = await CustomerModel.findById(pre.customerId);
    if (customer && !hasIdDocument(customer)) throw idDocumentRequired();
  }

  const loan = await LoanModel.findOneAndUpdate(
    { _id: loanId, deletedAt: { $ne: null } },
    { $set: { deletedAt: null }, $unset: { deletedById: '', deleteReason: '' } },
    { returnDocument: 'after' },
  );
  if (!loan) throw new AppError('NOT_TRASHED', 'Loan is not in the trash', 409);

  await audit({
    actorId: actor.sub,
    action: 'loan.restore',
    entityType: 'loan',
    entityId: pre._id,
    before: { status: pre.status, deletedAt: pre.deletedAt.toISOString() },
    after: { status: loan.status, deletedAt: null },
    ...(requestId !== undefined ? { requestId } : {}),
  });
  emitAdminEvent('loan.restored', {
    id: pre._id.toHexString(),
    customerId: pre.customerId.toHexString(),
    status: loan.status,
  });
  return toPublicLoan(loan);
}

export async function listLoanTrash(
  query: LoanTrashQuery,
): Promise<{ items: TrashedLoan[]; page: number; limit: number; total: number }> {
  const filter = { deletedAt: { $ne: null } };
  const [loans, total] = await Promise.all([
    LoanModel.find(filter)
      .sort({ deletedAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    LoanModel.countDocuments(filter),
  ]);
  const unique = [...new Set(loans.map((l) => l.customerId.toHexString()))];
  const customers = await CustomerModel.find({ _id: { $in: unique } }, { fullName: 1 });
  const names = new Map(customers.map((c) => [c._id.toHexString(), c.fullName]));
  return {
    items: loans.map((l) => ({
      ...toTrashedLoan(l),
      customerName: names.get(l.customerId.toHexString()) ?? '',
    })),
    page: query.page,
    limit: query.limit,
    total,
  };
}

// ---------------------------------------------------------------- receipts

export interface ReceiptFile {
  buffer: Buffer;
  filename: string;
}

/** The customer, staff name and display reference every loan receipt needs. */
async function loanReceiptContext(
  loanId: Types.ObjectId,
): Promise<{ loan: Loan; customer: Customer | null; reference: string }> {
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  const customer = await CustomerModel.findById(loan.customerId);
  // Loans written before the numbering scheme have no reference of their own.
  const reference = loan.accountNumber ?? loan._id.toHexString().slice(-8).toUpperCase();
  return { loan, customer, reference };
}

async function staffName(id: Types.ObjectId | null | undefined): Promise<string> {
  if (!id) return 'Yadah staff';
  const user = await UserModel.findById(id).select('name');
  return user?.name ?? 'Yadah staff';
}

/**
 * Proof the customer received the money.
 *
 * The figure is the PRINCIPAL handed over, not the total repayable — a
 * disbursement receipt records what left the drawer. What is owed back is
 * stated underneath so there is no ambiguity about the difference.
 */
export async function disbursementReceipt(loanId: Types.ObjectId): Promise<ReceiptFile> {
  const { loan, customer, reference } = await loanReceiptContext(loanId);
  if (!loan.disbursedAt) {
    throw new AppError('NOT_DISBURSED', 'This loan has not been disbursed yet', 422);
  }

  const lines: ReceiptLine[] = [
    { label: 'Loan tier', value: loan.tier === 'big' ? 'Big' : 'Small' },
    { label: 'Duration', value: `${String(loan.durationMonths)} months` },
    { label: 'Interest rate', value: `${String(loan.ratePercent)}% flat on principal` },
    { label: 'Interest', value: formatGhs(loan.interestAmount) },
    { label: 'Total repayable', value: formatGhs(loan.totalDue), emphasis: true },
    ...(loan.dueDate ? [{ label: 'Due by', value: accraDay(loan.dueDate) }] : []),
    // On the receipt because it is on the paper: the guarantor's copy of who
    // stood behind this money is the whole point of taking one.
    ...(loan.guarantorSnapshot
      ? [
          { label: 'Guarantor', value: loan.guarantorSnapshot.fullName },
          { label: 'Guarantor phone', value: loan.guarantorSnapshot.phone },
          ...(loan.guarantorSnapshot.idNumber
            ? [{ label: 'Guarantor ID', value: loan.guarantorSnapshot.idNumber }]
            : []),
        ]
      : []),
  ];

  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber('LD', loan._id),
    kind: 'withdrawal',
    title: 'Loan Disbursement',
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: reference,
    amount: loan.principal,
    lines,
    recordedByName: await staffName(loan.approvedById),
    at: loan.disbursedAt,
    reference: loan._id.toHexString(),
  });
  return { buffer, filename: `loan-disbursement-${receiptNumber('LD', loan._id)}.pdf` };
}

/**
 * Proof the customer paid.
 *
 * Balances are rebuilt as at THIS repayment rather than read off the loan, so
 * a reprint of an old receipt shows the position at the time it was issued —
 * not today's. A receipt is a record of a moment, and reprinting one must not
 * silently rewrite it.
 */
export async function repaymentReceipt(
  loanId: Types.ObjectId,
  repaymentId: Types.ObjectId,
): Promise<ReceiptFile> {
  const { loan, customer, reference } = await loanReceiptContext(loanId);
  const repayment = await RepaymentModel.findOne({ _id: repaymentId, loanId });
  if (!repayment) throw new AppError('NOT_FOUND', 'Repayment not found', 404);

  const [{ paid } = { paid: 0 }] = await RepaymentModel.aggregate<{ paid: number }>([
    { $match: { loanId, createdAt: { $lte: repayment.createdAt } } },
    { $group: { _id: null, paid: { $sum: '$amount' } } },
  ]);

  const SOURCE_LABELS: Record<Repayment['source'], string> = {
    cash: 'Cash',
    'susu-closure': 'Susu account closure',
    transfer: 'Internal transfer',
  };

  const lines: ReceiptLine[] = [
    { label: 'Paid by', value: SOURCE_LABELS[repayment.source] },
    { label: 'Total repayable', value: formatGhs(loan.totalDue) },
    { label: 'Repaid to date', value: formatGhs(paid) },
    {
      label: 'Remaining after this',
      value: formatGhs(Math.max(0, loan.totalDue - paid)),
      emphasis: true,
    },
    { label: 'Payment method', value: repayment.channel },
  ];

  const buffer = await buildReceiptPdf({
    receiptNo: receiptNumber('LR', repayment._id),
    kind: 'deposit',
    title: 'Loan Repayment',
    customerName: customer?.fullName ?? 'Customer',
    ...(customer?.phone !== undefined ? { customerPhone: customer.phone } : {}),
    accountNumber: reference,
    amount: repayment.amount,
    lines,
    recordedByName: await staffName(repayment.recordedById),
    at: repayment.createdAt,
    reference: repayment._id.toHexString(),
  });
  return { buffer, filename: `loan-repayment-${receiptNumber('LR', repayment._id)}.pdf` };
}
