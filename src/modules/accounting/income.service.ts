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
 * That is deterministic and needs no amortisation schedule. The split is
 * taken over the running total paid on the debt, not payment by payment, so
 * the pesewas add up: a fully repaid loan has earned exactly its interest, and
 * the balance sheet's unearned interest is always the remainder.
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

/**
 * The interest in `paid` of a debt carrying `interest` in a `total` owed.
 * One rounding over the running total, never one per payment: the pesewas
 * then add up exactly, and what the balance sheet still calls unearned
 * (`interest − interestPortion(paid so far)`) is the other half of the same sum.
 */
export function interestPortion(paid: number, interest: number, total: number): number {
  return total === 0 ? 0 : Math.round((paid * interest) / total);
}

export async function interestEarned(from: string, to: string): Promise<InterestEarned> {
  const { start, end } = dayWindow(from, to);
  const createdAt = { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) };
  const upToEnd = end ? { createdAt: { $lt: end } } : {};

  // Which debts were paid on in the period — then everything paid on them up
  // to its end, so each is read as a running total: what it had earned by the
  // end less what it had earned before the start.
  const [loanIds, agreementIds] = await Promise.all([
    RepaymentModel.distinct('loanId', { createdAt, ...NOT_TRASHED }),
    // A deposit is not interest — it is the customer's own money down. Only
    // instalments and redemptions carry the financed interest.
    HpPaymentModel.distinct('agreementId', {
      createdAt,
      type: { $in: ['installment', 'redemption'] },
      ...NOT_TRASHED,
    }),
  ]);

  const [repayments, hpPayments, loans, agreements] = await Promise.all([
    RepaymentModel.find(
      { loanId: { $in: loanIds }, ...upToEnd, ...NOT_TRASHED },
      { loanId: 1, amount: 1, createdAt: 1 },
    ),
    HpPaymentModel.find(
      {
        agreementId: { $in: agreementIds },
        type: { $in: ['installment', 'redemption'] },
        ...upToEnd,
        ...NOT_TRASHED,
      },
      { agreementId: 1, amount: 1, createdAt: 1 },
    ),
    LoanModel.find({ _id: { $in: loanIds } }, { interestAmount: 1, totalDue: 1 }),
    HpAgreementModel.find({ _id: { $in: agreementIds } }, { interestAmount: 1, totalPayable: 1 }),
  ]);

  /** Paid before the period and by its end, per debt. */
  const running = (rows: { id: string; amount: number; createdAt: Date }[]) => {
    const out = new Map<string, { before: number; byEnd: number }>();
    for (const r of rows) {
      const sums = out.get(r.id) ?? { before: 0, byEnd: 0 };
      sums.byEnd += r.amount;
      if (start && r.createdAt.getTime() < start.getTime()) sums.before += r.amount;
      out.set(r.id, sums);
    }
    return out;
  };
  const loanPaid = running(
    repayments.map((r) => ({
      id: r.loanId.toHexString(),
      amount: r.amount,
      createdAt: r.createdAt,
    })),
  );
  const hpPaid = running(
    hpPayments.map((p) => ({
      id: p.agreementId.toHexString(),
      amount: p.amount,
      createdAt: p.createdAt,
    })),
  );

  let loanInterest = 0;
  for (const l of loans) {
    const paid = loanPaid.get(l._id.toHexString());
    if (!paid) continue;
    loanInterest +=
      interestPortion(paid.byEnd, l.interestAmount, l.totalDue) -
      interestPortion(paid.before, l.interestAmount, l.totalDue);
  }
  let hpInterest = 0;
  for (const a of agreements) {
    const paid = hpPaid.get(a._id.toHexString());
    if (!paid) continue;
    const interest = a.interestAmount ?? 0;
    const payable = a.totalPayable ?? 0;
    hpInterest +=
      interestPortion(paid.byEnd, interest, payable) -
      interestPortion(paid.before, interest, payable);
  }

  return { from, to, loanInterest, hpInterest, total: loanInterest + hpInterest };
}
