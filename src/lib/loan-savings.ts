import { LoanModel, LoanScheduleModel } from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';
import {
  amountDueByMonthEnd,
  deductionAmount,
  deductionMonth,
  monthEndExclusive,
} from '../domain/loan-savings.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { SYSTEM_ACTOR_ID } from './debt-recovery.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { accraDay } from './time.js';
import { recordWorkerRun, recordWorkerStart } from './worker-status.js';

/**
 * The month-end loan savings deduction (client decision, 6 Oct 2026).
 *
 * On the last day of each month, every open loan whose customer has a loan
 * savings account is paid from it: what the loan expects by the end of that
 * month and has not had, or whatever the account holds if that is less. See
 * domain/loan-savings.ts for the rules.
 *
 * Runs hourly like the other workers, and is safe to: each loan carries the
 * last month it was dealt with (`loanSavingsMonth`), so it is handled once a
 * month however many passes run, and each deduction's idempotency key names
 * the loan and the month, so a pass that dies between the repayment and the
 * mark replays rather than paying twice. A loan whose customer has nothing in
 * loan savings is still marked: money paid in later that month waits for the
 * next month end, as the customer was told it would.
 *
 * Recorded by the system actor, so the feed shows it as automation, and the
 * customer gets the usual repayment SMS.
 */

const systemActor: AccessTokenPayload = { sub: SYSTEM_ACTOR_ID, role: 'admin' };

export async function runLoanSavingsPass(
  now: Date = new Date(),
): Promise<{ month: string | null; loans: number; deducted: number; amount: number }> {
  const month = deductionMonth(accraDay(now));
  if (month === null) return { month, loans: 0, deducted: 0, amount: 0 };
  const monthEnd = monthEndExclusive(month);

  // Imported here, as loan-escalation does: the loans service reaches the
  // workers' modules, and a top-level import would close the loop.
  const { findLoanSavingsAccount, repayFromLoanSavings } =
    await import('../modules/loans/loans.service.js');

  const loans = await LoanModel.find({
    status: { $in: ['active', 'arrears'] },
    disbursedAt: { $lt: monthEnd },
    $or: [{ loanSavingsMonth: { $exists: false } }, { loanSavingsMonth: { $lt: month } }],
    ...NOT_TRASHED,
  });

  let deducted = 0;
  let amount = 0;
  for (const loan of loans) {
    try {
      const account = await findLoanSavingsAccount(loan.customerId);
      if (account && account.balance > 0) {
        const schedule = await LoanScheduleModel.find({ loanId: loan._id });
        const due = amountDueByMonthEnd(loan, schedule, monthEnd);
        const take = deductionAmount(due, account.balance);
        if (take > 0) {
          const result = await repayFromLoanSavings(
            systemActor,
            loan._id,
            take,
            `month-end:${loan._id.toHexString()}:${month}`,
          );
          if (!result.replayed) {
            deducted++;
            amount += take;
          }
        }
      }
      await LoanModel.updateOne({ _id: loan._id }, { $set: { loanSavingsMonth: month } });
    } catch (err) {
      // Left unmarked, so the next pass tries again; anything but a refusal
      // (a concurrent change, a balance moved meanwhile) is a real fault.
      if (!(err instanceof AppError)) throw err;
      logger.warn(
        { loan: loan._id.toHexString(), month, code: err.code },
        'loan savings deduction skipped',
      );
    }
  }

  if (deducted > 0) {
    logger.info({ month, deducted, amount }, 'loan savings month-end deductions applied');
  }
  return { month, loans: loans.length, deducted, amount };
}

let timer: NodeJS.Timeout | null = null;

export function startLoanSavingsWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  recordWorkerStart('loan-savings');
  const run = (): void => {
    runLoanSavingsPass()
      .then(({ deducted, amount }) => {
        recordWorkerRun('loan-savings', { ok: true, changes: { deducted, amount } });
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'loan savings pass errored');
        recordWorkerRun('loan-savings', { ok: false, error: String(err) });
      });
  };
  run();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopLoanSavingsWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
