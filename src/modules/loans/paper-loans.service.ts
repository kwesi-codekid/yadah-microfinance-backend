import mongoose, { Types } from 'mongoose';
import { nextAccountNumber } from '../../lib/account-number.js';
import { audit } from '../../lib/audit.js';
import { assertPaperEntryOpen, paperDay } from '../../lib/backdating.js';
import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { CustomerModel, LoanModel, LoanScheduleModel, RepaymentModel } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import {
  LOAN_DURATIONS,
  addMonthsClamped,
  allocateRepayment,
  buildSchedule,
  computeInterest,
  paperEscalationStart,
  tierFor,
} from '../../domain/loans.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import {
  OPEN_LOAN_STATUSES,
  getLoanConfig,
  toPublicLoan,
  type PublicLoan,
} from './loans.service.js';
import type { PaperLoanBody } from './loans.schemas.js';

/**
 * Loans the branch made on paper before the system existed.
 *
 * The application flow cannot take them: it stamps every date as today, waits
 * for an approval that would disburse the money today, and books every
 * repayment as today's cash. A paper loan is history, so it is written as
 * history — dated on the day the money went out, carrying the rate the paper
 * says is owed now, and with each payment the paper records on the day it was
 * made. The cash book, the P&L and the loan reports all read those dates, so
 * each one lands in the month it belongs to.
 *
 * Client decisions (29 Sep 2026): the paper rate stands and escalation only
 * carries on from it; repayments go in one by one with their dates; loans the
 * customer has already finished paying go in too, because a small loan repaid
 * on time is what opens the big tier; and there is no limit on how old the
 * paper may be.
 *
 * What still applies is what protects the branch today: one open loan per
 * customer, and a loan and a hire purchase agreement never open together.
 * What does not is what a paper loan predates — the ID scans, the photographed
 * signature, the saving history. Every one is marked `origin: 'paper'` so it
 * is never mistaken for an application that went through the counter.
 */

export async function recordPaperLoan(
  actor: AccessTokenPayload,
  input: PaperLoanBody,
  requestId?: string,
): Promise<PublicLoan> {
  assertPaperEntryOpen(actor);
  const now = new Date();

  // ------------------------------------------------------------- the dates
  const disbursedAt = paperDay(input.disbursedOn, now);
  const appliedAt = input.appliedOn !== undefined ? paperDay(input.appliedOn, now) : disbursedAt;
  if (appliedAt.getTime() > disbursedAt.getTime()) {
    throw new AppError(
      'PAPER_DATES',
      'The application cannot be dated after the money was given out',
      422,
    );
  }
  // Oldest first, and the order they are written in breaks ties on one day.
  const payments = input.repayments
    .map((p, i) => ({ at: paperDay(p.paidOn, now), amount: p.amount, i }))
    .sort((a, b) => a.at.getTime() - b.at.getTime() || a.i - b.i)
    .map((p, order) => ({ ...p, at: new Date(p.at.getTime() + order) }));
  for (const p of payments) {
    if (p.at.toISOString().slice(0, 10) < input.disbursedOn) {
      throw new AppError(
        'PAPER_DATES',
        `A payment on ${p.at.toISOString().slice(0, 10)} is before the money was given out (${input.disbursedOn})`,
        422,
      );
    }
  }

  // ------------------------------------------------------------- the money
  const config = await getLoanConfig();
  if (!LOAN_DURATIONS.some((d) => config.rates[d] === input.ratePercent)) {
    throw new AppError(
      'PAPER_RATE',
      `${String(input.ratePercent)}% is not one of the rates the branch lends at`,
      422,
    );
  }
  // A paper loan may sit outside today's tier limits; it was lent under its
  // own. It is filed under whichever tier its size is nearest.
  const tier =
    tierFor(input.principal, config.tiers) ??
    (input.principal <= config.tiers.smallMax ? 'small' : 'big');
  const interestAmount = computeInterest(input.principal, input.ratePercent);
  const totalDue = input.principal + interestAmount;
  const totalRepaid = payments.reduce((sum, p) => sum + p.amount, 0);
  if (totalRepaid > totalDue) {
    throw new AppError(
      'EXCEEDS_BALANCE',
      `The payments add up to ${formatGhs(totalRepaid)}, more than the ${formatGhs(totalDue)} owed`,
      422,
      { totalDue, totalRepaid },
    );
  }
  const repaid = totalRepaid === totalDue;
  const dueDate = addMonthsClamped(disbursedAt, input.durationMonths);
  const closedAt = repaid ? payments[payments.length - 1]?.at : undefined;

  // ------------------------------------------------------------- the checks
  const customer = await CustomerModel.findOne({ _id: input.customerId, ...NOT_TRASHED });
  if (!customer) throw new AppError('NOT_FOUND', 'Customer not found', 404);

  if (input.paperRef !== undefined) {
    const copied = await LoanModel.exists({ paperRef: input.paperRef, ...NOT_TRASHED });
    if (copied) {
      throw new AppError(
        'PAPER_DUPLICATE',
        `Paper loan ${input.paperRef} has already been entered`,
        409,
        { paperRef: input.paperRef },
      );
    }
  }

  // Only a loan still being paid is "open". A finished one sits beside
  // whatever the customer has now, as their history does.
  if (!repaid) {
    const open = await LoanModel.exists({
      customerId: input.customerId,
      status: { $in: OPEN_LOAN_STATUSES },
      ...NOT_TRASHED,
    });
    if (open) {
      throw new AppError('LOAN_EXISTS', `${customer.fullName} already has an open loan`, 409);
    }
    const { HpAgreementModel } = await import('../../models/index.js');
    const { OPEN_HP_STATUSES } = await import('../hire-purchase/hp.service.js');
    const openHp = await HpAgreementModel.exists({
      customerId: input.customerId,
      status: { $in: OPEN_HP_STATUSES },
      ...NOT_TRASHED,
    });
    if (openHp) {
      throw new AppError(
        'HP_EXISTS',
        `${customer.fullName} has an open hire purchase agreement — loans and HP block each other`,
        409,
      );
    }
  }

  // ------------------------------------------------------------- the writing
  const schedule = buildSchedule(totalDue, input.durationMonths, disbursedAt);
  const paidPerLine = schedule.map(() => 0);
  for (const p of payments) {
    const additions = allocateRepayment(
      schedule.map((line, i) => ({ amountDue: line.amountDue, amountPaid: paidPerLine[i] ?? 0 })),
      p.amount,
    );
    additions.forEach((add, i) => {
      paidPerLine[i] = (paidPerLine[i] ?? 0) + add;
    });
  }

  const [firstGuarantor, ...otherGuarantors] = input.guarantors.map((g) => ({
    fullName: g.fullName,
    phone: g.phone,
    ...(g.idNumber !== undefined ? { idNumber: g.idNumber } : {}),
  }));

  const loanId = new Types.ObjectId();
  // Numbered in the month the money went out, as it would have been then.
  const accountNumber = await nextAccountNumber('LN', disbursedAt);
  const escalationFrom = repaid
    ? undefined
    : paperEscalationStart(input.ratePercent, disbursedAt, now, config.rates);

  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      await LoanModel.create(
        [
          {
            _id: loanId,
            accountNumber,
            customerId: input.customerId,
            // The first guarantor where every screen already looks; any
            // others beside it.
            ...(firstGuarantor !== undefined ? { guarantorSnapshot: firstGuarantor } : {}),
            ...(otherGuarantors.length > 0 ? { moreGuarantors: otherGuarantors } : {}),
            tier,
            principal: input.principal,
            durationMonths: input.durationMonths,
            ratePercent: input.ratePercent,
            interestAmount,
            totalDue,
            totalRepaid,
            status: repaid ? 'repaid' : 'active',
            frozen: false,
            appliedAt,
            approvedAt: disbursedAt,
            disbursedAt,
            dueDate,
            ...(closedAt !== undefined
              ? { closedAt, repaidOnTime: closedAt.getTime() <= dueDate.getTime() }
              : {}),
            ...(escalationFrom !== undefined && escalationFrom.getTime() !== disbursedAt.getTime()
              ? { escalationFrom }
              : {}),
            origin: 'paper',
            ...(input.paperRef !== undefined ? { paperRef: input.paperRef } : {}),
            ...(input.paperPhotoUrl !== undefined ? { paperPhotoUrl: input.paperPhotoUrl } : {}),
          },
        ],
        { session },
      );

      await LoanScheduleModel.create(
        schedule.map((line, i) => {
          const paid = paidPerLine[i] ?? 0;
          return {
            loanId,
            customerId: input.customerId,
            installmentNumber: line.installmentNumber,
            dueDate: line.dueDate,
            amountDue: line.amountDue,
            amountPaid: paid,
            status:
              paid >= line.amountDue
                ? 'paid'
                : paid > 0
                  ? 'partial'
                  : line.dueDate.getTime() < now.getTime()
                    ? 'overdue'
                    : 'pending',
          };
        }),
        { session, ordered: true },
      );

      if (payments.length > 0) {
        // Dated the day each was paid, which is what puts it in the right
        // month of the cash book. `_id` still carries when it was typed.
        await RepaymentModel.create(
          payments.map((p) => ({
            loanId,
            customerId: input.customerId,
            amount: p.amount,
            source: 'cash',
            channel: 'cash',
            recordedById: new Types.ObjectId(actor.sub),
            idempotencyKey: `paper:${loanId.toHexString()}:${String(p.i)}`,
            createdAt: p.at,
            updatedAt: now,
          })),
          { session, ordered: true, timestamps: false },
        );
      }

      await audit(
        {
          actorId: actor.sub,
          action: 'loan.paper-record',
          entityType: 'loan',
          entityId: loanId,
          amountAfter: totalDue - totalRepaid,
          after: {
            paperRef: input.paperRef ?? null,
            principal: input.principal,
            durationMonths: input.durationMonths,
            ratePercent: input.ratePercent,
            disbursedOn: input.disbursedOn,
            repayments: payments.length,
            totalRepaid,
            status: repaid ? 'repaid' : 'active',
          },
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
  return toPublicLoan(loan);
}
