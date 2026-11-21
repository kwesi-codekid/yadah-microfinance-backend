import mongoose, { Types } from 'mongoose';
import { isMinor, minorCreditRefused } from '../../lib/age.js';
import { audit } from '../../lib/audit.js';
import { paperDay } from '../../lib/backdating.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { accraDay } from '../../lib/time.js';
import {
  addMonthsClamped,
  allocateRepayment,
  buildSchedule,
  computeInterest,
  LOAN_DURATIONS,
  paperEscalationStart,
  tierFor,
} from '../../domain/loans.js';
import {
  CustomerModel,
  HpAgreementModel,
  LoanModel,
  LoanScheduleModel,
  RepaymentModel,
  type Loan,
} from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { recordLoanFee, removeLoanFee } from '../commissions/commissions.ledger.js';
import { OPEN_HP_STATUSES } from '../hire-purchase/hp.service.js';
import {
  getLoanConfig,
  isBigTierUnlocked,
  OPEN_LOAN_STATUSES,
  toPublicLoan,
  type PublicLoan,
} from './loans.service.js';
import type { EditLoanBody } from './loans.schemas.js';

/**
 * Changing a loan after it was written (client decision, 4 Nov 2026) — any
 * term, at any stage but a rejected application. Office only, with a reason.
 *
 * A pending loan has moved no money, so this is only the application changing.
 * A disbursed loan has: its totals, schedule, processing fee and status are
 * all worked out afresh from the new terms and written in one transaction, so
 * the books read as if the loan had been written this way from the start. The
 * repayments themselves stay exactly as they are; they are laid over the new
 * schedule oldest instalment first, and a change that would leave the customer
 * having paid more than they owe is refused.
 *
 * Two things are deliberate:
 *
 *  - The rate typed here stands. Without the escalation clock moving, the
 *    hourly pass would overrule it for any loan older than that rate's window,
 *    so the clock is reset the way a paper loan's is (paperEscalationStart).
 *  - A customer can only be changed before any repayment landed. Repayments
 *    are the old customer's money, and may have come out of their accounts.
 */
export async function editLoan(
  actor: AccessTokenPayload,
  loanId: Types.ObjectId,
  input: EditLoanBody,
  requestId?: string,
): Promise<PublicLoan> {
  const loan = await LoanModel.findOne({ _id: loanId, ...NOT_TRASHED });
  if (!loan) throw new AppError('NOT_FOUND', 'Loan not found', 404);
  if (loan.status === 'rejected') {
    throw new AppError('LOAN_NOT_EDITABLE', 'A rejected application cannot be changed', 422);
  }
  const disbursed = loan.disbursedAt !== undefined;
  if (!disbursed && (input.ratePercent !== undefined || input.disbursedOn !== undefined)) {
    throw new AppError(
      'LOAN_NOT_DISBURSED',
      'This loan has not gone out yet — its rate and date are set on approval',
      422,
    );
  }

  const now = new Date();
  const config = await getLoanConfig();
  const repayments = await RepaymentModel.find({ loanId, ...NOT_TRASHED }).sort({ createdAt: 1 });
  const principal = input.principal ?? loan.principal;
  const durationMonths = input.durationMonths ?? loan.durationMonths;
  const customerId = input.customerId ?? loan.customerId;
  const customerChanged = !customerId.equals(loan.customerId);
  const principalChanged = principal !== loan.principal;
  const durationChanged = durationMonths !== loan.durationMonths;

  // ------------------------------------------------------------- the rate
  // A pending loan takes the going rate for its duration, as approval will.
  // A disbursed one keeps the rate it has unless told otherwise: it may have
  // escalated, and changing the principal is no reason to undo that.
  const ratePercent = !disbursed
    ? config.rates[durationMonths]
    : (input.ratePercent ?? (durationChanged ? config.rates[durationMonths] : loan.ratePercent));
  const rateChanged = ratePercent !== loan.ratePercent;

  // ------------------------------------------------------------- the date
  const disbursedAt =
    input.disbursedOn !== undefined && disbursed && input.disbursedOn !== accraDay(loan.disbursedAt)
      ? paperDay(input.disbursedOn, now)
      : loan.disbursedAt;
  const dateChanged = disbursedAt?.getTime() !== loan.disbursedAt?.getTime();
  const firstPaid = repayments[0]?.createdAt;
  if (dateChanged && disbursedAt && firstPaid && accraDay(firstPaid) < accraDay(disbursedAt)) {
    throw new AppError(
      'DATE_BEFORE_LOAN',
      `A repayment was made on ${accraDay(firstPaid)}, before that date`,
      422,
    );
  }

  const clockChanged = rateChanged || durationChanged || dateChanged;
  if (clockChanged && disbursed && !LOAN_DURATIONS.some((d) => config.rates[d] === ratePercent)) {
    throw new AppError(
      'RATE_NOT_OFFERED',
      `${String(ratePercent)}% is not one of the rates the branch lends at`,
      422,
    );
  }

  // ------------------------------------------------------------- the tier
  let tier = loan.tier;
  if (principalChanged) {
    const fits = tierFor(principal, config.tiers);
    // A paper loan was lent under its own limits, as when it was entered.
    if (!fits && loan.origin !== 'paper') {
      throw new AppError(
        'PRINCIPAL_OUT_OF_RANGE',
        `Principal must be between ${formatGhs(config.tiers.smallMin)} and ${formatGhs(config.tiers.bigMax)}`,
        422,
      );
    }
    tier = fits ?? (principal <= config.tiers.smallMax ? 'small' : 'big');
  }
  const tierNeedsCheck = (principalChanged && tier !== loan.tier) || customerChanged;
  if (tierNeedsCheck && tier === 'big' && loan.origin !== 'paper') {
    if (!(await isBigTierUnlocked(customerId))) {
      throw new AppError(
        'BIG_TIER_LOCKED',
        'The big tier requires a previous small loan repaid on time',
        422,
      );
    }
  }

  // ------------------------------------------------------------- the totals
  const interestAmount = computeInterest(principal, ratePercent);
  const totalDue = principal + interestAmount;
  if (loan.totalRepaid > totalDue) {
    throw new AppError(
      'BELOW_REPAID',
      `${formatGhs(loan.totalRepaid)} has already been repaid, more than the ${formatGhs(totalDue)} this would make the loan`,
      422,
      { totalDue, totalRepaid: loan.totalRepaid },
    );
  }

  // ------------------------------------------------------------- the status
  const settled = disbursed && loan.totalRepaid === totalDue;
  const reopens = loan.status === 'repaid' && !settled;
  if (reopens && !customerChanged) await assertNoOtherOpenLoan(customerId, loanId);

  if (customerChanged) await assertCustomerCanTakeLoan(loan, customerId, repayments.length);

  // ------------------------------------------------------------- the charges
  const processingFee = input.processingFee ?? loan.processingFee ?? 0;
  const collateralAmount = input.collateralAmount ?? loan.collateralAmount ?? 0;
  const feeChanged = processingFee !== (loan.processingFee ?? 0);
  const collateralChanged = collateralAmount !== (loan.collateralAmount ?? 0);
  if (collateralChanged && loan.collateralReturnedAt) {
    throw new AppError(
      'COLLATERAL_RETURNED',
      'This collateral has already been handed back, so it cannot be changed',
      422,
    );
  }

  // ------------------------------------------------------------- the rest
  const guarantors = input.guarantors;
  const guarantorsChanged = guarantors !== undefined && !sameGuarantors(guarantors, loan);
  if (guarantorsChanged && guarantors.length === 0 && loan.origin !== 'paper') {
    throw new AppError('GUARANTOR_REQUIRED', 'A loan needs at least one guarantor', 422);
  }
  const paperRef = input.paperRef;
  const paperRefChanged = paperRef !== undefined && paperRef !== loan.paperRef;
  if (paperRefChanged) {
    const taken = await LoanModel.exists({
      _id: { $ne: loanId },
      paperRef,
      ...NOT_TRASHED,
    });
    if (taken) {
      throw new AppError('PAPER_DUPLICATE', `Paper loan ${paperRef} already exists`, 409);
    }
  }

  // ------------------------------------------------------------- the writes
  const set: Record<string, unknown> = {};
  const unset: Record<string, ''> = {};
  const assign = (field: string, value: unknown, before: unknown): void => {
    if (value !== before) set[field] = value;
  };
  assign('principal', principal, loan.principal);
  assign('tier', tier, loan.tier);
  assign('durationMonths', durationMonths, loan.durationMonths);
  assign('ratePercent', ratePercent, loan.ratePercent);
  assign('interestAmount', interestAmount, loan.interestAmount);
  assign('totalDue', totalDue, loan.totalDue);
  if (customerChanged) set.customerId = customerId;
  if (paperRefChanged) set.paperRef = paperRef;
  if (feeChanged) {
    if (processingFee > 0) set.processingFee = processingFee;
    else unset.processingFee = '';
  }
  if (collateralChanged) {
    if (collateralAmount > 0) set.collateralAmount = collateralAmount;
    else unset.collateralAmount = '';
  }
  if (guarantorsChanged) {
    const [first, ...rest] = guarantors;
    unset.guarantorId = '';
    if (first) set.guarantorSnapshot = first;
    else unset.guarantorSnapshot = '';
    if (rest.length > 0) set.moreGuarantors = rest;
    else unset.moreGuarantors = '';
  }

  let status = loan.status;
  if (disbursed && disbursedAt) {
    const dueDate = addMonthsClamped(disbursedAt, durationMonths);
    if (dateChanged) set.disbursedAt = disbursedAt;
    if (dueDate.getTime() !== loan.dueDate?.getTime()) set.dueDate = dueDate;
    if (settled) {
      const closedAt = loan.closedAt ?? repayments[repayments.length - 1]?.createdAt ?? now;
      status = 'repaid';
      set.closedAt = closedAt;
      set.frozen = false;
      set.repaidOnTime = closedAt.getTime() <= dueDate.getTime();
    } else {
      if (reopens) {
        status = 'active';
        unset.closedAt = '';
        unset.repaidOnTime = '';
      }
      if (loan.status === 'arrears' && clockChanged) {
        status = 'active';
        set.frozen = false;
      }
    }
    if (status !== loan.status) set.status = status;
    if (clockChanged) {
      const start = paperEscalationStart(ratePercent, disbursedAt, now, config.rates);
      if (start.getTime() === disbursedAt.getTime()) unset.escalationFrom = '';
      else set.escalationFrom = start;
    }
  }

  if (Object.keys(set).length === 0 && Object.keys(unset).length === 0) return toPublicLoan(loan);

  const termsChanged = principalChanged || rateChanged || durationChanged || dateChanged;
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      const upd = await LoanModel.updateOne(
        {
          _id: loanId,
          status: loan.status,
          totalDue: loan.totalDue,
          totalRepaid: loan.totalRepaid,
          ...NOT_TRASHED,
        },
        {
          ...(Object.keys(set).length > 0 ? { $set: set } : {}),
          ...(Object.keys(unset).length > 0 ? { $unset: unset } : {}),
        },
        // `principal` is immutable to everything else in the system. This is
        // the one place allowed to change it.
        { session, overwriteImmutable: true },
      );
      if (upd.modifiedCount !== 1) {
        throw new AppError('CONFLICT', 'Loan was updated concurrently — retry', 409);
      }

      if (disbursedAt && (termsChanged || customerChanged)) {
        await LoanScheduleModel.deleteMany({ loanId }, { session });
        const lines = buildSchedule(totalDue, durationMonths, disbursedAt);
        const paid = allocateRepayment(
          lines.map((line) => ({ amountDue: line.amountDue, amountPaid: 0 })),
          loan.totalRepaid,
        );
        await LoanScheduleModel.create(
          lines.map((line, i) => {
            const amountPaid = paid[i] ?? 0;
            return {
              loanId,
              customerId,
              installmentNumber: line.installmentNumber,
              dueDate: line.dueDate,
              amountDue: line.amountDue,
              amountPaid,
              status:
                amountPaid >= line.amountDue
                  ? 'paid'
                  : amountPaid > 0
                    ? 'partial'
                    : line.dueDate.getTime() < now.getTime()
                      ? 'overdue'
                      : 'pending',
            };
          }),
          { session, ordered: true },
        );
      }

      if (disbursedAt && (feeChanged || dateChanged || customerChanged)) {
        await removeLoanFee(session, loanId);
        await recordLoanFee(session, {
          _id: loanId,
          customerId,
          processingFee,
          disbursedAt,
          ...(loan.approvedById ? { approvedById: loan.approvedById } : {}),
        });
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'loan.edit',
          entityType: 'loan',
          entityId: loanId,
          amountBefore: loan.totalDue,
          amountAfter: totalDue,
          before: snapshot(loan),
          after: { reason: input.reason, set, unset: Object.keys(unset) },
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
  emitAdminEvent('loan.edited', {
    id: loanId.toHexString(),
    customerId: after.customerId.toHexString(),
    totalDueBefore: loan.totalDue,
    totalDue: after.totalDue,
  });
  return toPublicLoan((await LoanModel.findById(loanId)) ?? after);
}

function snapshot(loan: Loan): Record<string, unknown> {
  return {
    customerId: loan.customerId.toHexString(),
    principal: loan.principal,
    durationMonths: loan.durationMonths,
    ratePercent: loan.ratePercent,
    totalDue: loan.totalDue,
    status: loan.status,
    processingFee: loan.processingFee ?? 0,
    collateralAmount: loan.collateralAmount ?? 0,
    ...(loan.disbursedAt ? { disbursedAt: loan.disbursedAt.toISOString() } : {}),
    ...(loan.guarantorSnapshot ? { guarantor: loan.guarantorSnapshot.fullName } : {}),
    ...(loan.paperRef !== undefined ? { paperRef: loan.paperRef } : {}),
  };
}

/** Compares what the form can show, so re-saving it leaves a registered guarantor linked. */
function sameGuarantors(guarantors: NonNullable<EditLoanBody['guarantors']>, loan: Loan): boolean {
  const current = [
    ...(loan.guarantorSnapshot ? [loan.guarantorSnapshot] : []),
    ...(loan.moreGuarantors ?? []),
  ];
  return (
    guarantors.length === current.length &&
    guarantors.every((g, i) => {
      const c = current[i];
      return (
        c?.fullName === g.fullName &&
        g.phone === c.phone &&
        (g.idNumber ?? '') === (c.idNumber ?? '')
      );
    })
  );
}

async function assertNoOtherOpenLoan(
  customerId: Types.ObjectId,
  loanId: Types.ObjectId,
): Promise<void> {
  const open = await LoanModel.exists({
    _id: { $ne: loanId },
    customerId,
    status: { $in: OPEN_LOAN_STATUSES },
    ...NOT_TRASHED,
  });
  if (open) {
    throw new AppError('LOAN_EXISTS', 'That customer already has a pending or active loan', 409);
  }
}

/** The same bars a new application meets, for a loan moved to another customer. */
async function assertCustomerCanTakeLoan(
  loan: Loan,
  customerId: Types.ObjectId,
  repaymentCount: number,
): Promise<void> {
  if (repaymentCount > 0 || loan.totalRepaid > 0) {
    throw new AppError(
      'LOAN_HAS_REPAYMENTS',
      'Repayments have been made on this loan, so it cannot move to another customer',
      422,
    );
  }
  if (loan.guarantorId?.equals(customerId)) {
    throw new AppError(
      'GUARANTOR_IS_BORROWER',
      'The borrower cannot guarantee their own loan',
      422,
    );
  }
  const customer = await CustomerModel.findOne({ _id: customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);
  if (customer.status !== 'active') {
    throw new AppError('CUSTOMER_INACTIVE', 'Customer is not active', 422);
  }
  if (isMinor(customer.dateOfBirth)) throw minorCreditRefused();
  await assertNoOtherOpenLoan(customerId, loan._id);
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
}
