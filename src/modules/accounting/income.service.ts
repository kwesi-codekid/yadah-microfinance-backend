import { HpAgreementModel, HpPaymentModel, LoanModel, RepaymentModel } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { dayWindow } from '../../lib/time.js';

/**
 * Interest income, recognised on a CASH basis: interest becomes income as the
 * customer repays it, not when the loan is written (client decision
 * 2026-08-27).
 *
 * Why cash basis here specifically. Overdue escalation applies the next tier's
 * rate to the ORIGINAL principal and rewrites the loan's interestAmount, so a
 * loan's total interest changes retroactively; under accrual, every escalation
 * would restate interest already recognised in closed periods. The
 * frozen-past-30% rule compounds it by leaving loans that may never pay.
 * Recognising on repayment sidesteps both, and never books income that did not
 * arrive.
 *
 * Both products use FLAT interest fixed at the start, so each repayment is
 * split in the same proportion the loan itself carries:
 *
 *     interest portion = repayment × interestAmount / totalDue
 *
 * That is deterministic and needs no amortisation schedule. Rounding is applied
 * per repayment, so a fully repaid loan may differ from its nominal interest by
 * a few pesewas — accepted, and far smaller than the distortion accrual would
 * introduce on an escalated loan.
 *
 * Every repayment is stored with its date and loan, so switching to accrual
 * later is a reporting change over existing data, not a migration.
 */

export interface InterestEarned {
  from: string;
  to: string;
  loanInterest: number;
  hpInterest: number;
  total: number;
}

export async function interestEarned(from: string, to: string): Promise<InterestEarned> {
  const { start, end } = dayWindow(from, to);
  const createdAt = { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) };

  const [repayments, hpPayments] = await Promise.all([
    RepaymentModel.find({ createdAt, ...NOT_TRASHED }),
    // A deposit is not interest — it is the customer's own money down. Only
    // instalments and redemptions carry the financed interest.
    HpPaymentModel.find({
      createdAt,
      type: { $in: ['installment', 'redemption'] },
      ...NOT_TRASHED,
    }),
  ]);

  const loanIds = [...new Set(repayments.map((r) => r.loanId.toHexString()))];
  const agreementIds = [...new Set(hpPayments.map((p) => p.agreementId.toHexString()))];

  const [loans, agreements] = await Promise.all([
    LoanModel.find({ _id: { $in: loanIds } }, { interestAmount: 1, totalDue: 1 }),
    HpAgreementModel.find({ _id: { $in: agreementIds } }, { interestAmount: 1, totalPayable: 1 }),
  ]);

  const loanRatio = new Map(
    loans.map((l) => [l._id.toHexString(), l.totalDue === 0 ? 0 : l.interestAmount / l.totalDue]),
  );
  const hpRatio = new Map(
    agreements.map((a) => {
      const payable = a.totalPayable ?? 0;
      return [a._id.toHexString(), payable === 0 ? 0 : (a.interestAmount ?? 0) / payable];
    }),
  );

  const loanInterest = repayments.reduce(
    (sum, r) => sum + Math.round(r.amount * (loanRatio.get(r.loanId.toHexString()) ?? 0)),
    0,
  );
  const hpInterest = hpPayments.reduce(
    (sum, p) => sum + Math.round(p.amount * (hpRatio.get(p.agreementId.toHexString()) ?? 0)),
    0,
  );

  return { from, to, loanInterest, hpInterest, total: loanInterest + hpInterest };
}
