import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { LoanModel, LoanScheduleModel, SusuLoanAccountModel } from '../models/index.js';
import type { Loan } from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';
import { amountDueBy, deductionAmount } from '../domain/susu-loan.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';
import { SYSTEM_ACTOR_ID } from './debt-recovery.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { recordWorkerRun, recordWorkerStart } from './worker-status.js';

/**
 * The susu loan deduction (client decisions, 6 and 23 Oct 2026).
 *
 * Each open loan whose customer has money in their susu loan account is paid from it on
 * the loan's own monthly dates: what has fallen due by today and is not yet
 * paid, or whatever the account holds if that is less. See
 * domain/susu-loan.ts for the rules.
 *
 * It runs two ways. The hourly pass sweeps every loan, so a monthly date is
 * met on its day and an old paper loan catches up the hour after it is typed
 * in. And a deposit into the susu loan account sweeps that customer's loans at once
 * (`sweepSusuLoan`), so a month left short is covered the moment money
 * arrives, not an hour later.
 *
 * Nothing is marked on the loan: what is owed is read fresh each time from
 * the schedule, so a pass that runs twice takes nothing the second time, and
 * one that dies halfway leaves nothing to replay. Two passes racing for the
 * same loan cannot both pay it: the repayment only lands on the loan as it
 * was read, and the loser is refused as a concurrent change.
 *
 * Recorded by the system actor, so the feed shows it as automation, and the
 * customer gets the usual repayment SMS.
 */

const systemActor: AccessTokenPayload = { sub: SYSTEM_ACTOR_ID, role: 'admin' };

/** Takes what one loan is owed from the susu loan account; returns the amount taken. */
async function deductForLoan(loan: Loan, now: Date): Promise<number> {
  // Imported here, as loan-escalation does: the loans service reaches the
  // workers' modules, and a top-level import would close the loop.
  const { findSusuLoanAccount, repayFromSusuLoan } =
    await import('../modules/loans/loans.service.js');

  const account = await findSusuLoanAccount(loan.customerId);
  if (!account || account.balance <= 0) return 0;
  const schedule = await LoanScheduleModel.find({ loanId: loan._id });
  const take = deductionAmount(amountDueBy(loan, schedule, now), account.balance);
  if (take <= 0) return 0;
  try {
    await repayFromSusuLoan(systemActor, loan._id, take, `susu-loan-auto:${randomUUID()}`);
    return take;
  } catch (err) {
    // Left as it is, so the next pass tries again; anything but a refusal
    // (a concurrent change, a balance moved meanwhile) is a real fault.
    if (!(err instanceof AppError)) throw err;
    logger.warn({ loan: loan._id.toHexString(), code: err.code }, 'susu loan deduction skipped');
    return 0;
  }
}

/** Open loans first-out first, so the oldest is paid before a newer one. */
function openLoans(filter: Record<string, unknown>): Promise<Loan[]> {
  return LoanModel.find({
    status: { $in: ['active', 'arrears'] },
    disbursedAt: { $exists: true },
    ...filter,
    ...NOT_TRASHED,
  }).sort({ disbursedAt: 1 });
}

/**
 * Pays a customer's open loans from their susu loan account as far as it goes —
 * run after money goes into the account. Never throws: the deposit that
 * prompted it is already in, and the hourly pass will try again.
 */
export async function sweepSusuLoan(
  customerId: Types.ObjectId,
  now: Date = new Date(),
): Promise<number> {
  try {
    let amount = 0;
    for (const loan of await openLoans({ customerId })) amount += await deductForLoan(loan, now);
    return amount;
  } catch (err) {
    logger.warn({ err, customer: customerId.toHexString() }, 'susu loan sweep errored');
    return 0;
  }
}

export async function runSusuLoanPass(
  now: Date = new Date(),
): Promise<{ loans: number; deducted: number; amount: number }> {
  const holders = await SusuLoanAccountModel.distinct('customerId', {
    status: 'active',
    balance: { $gt: 0 },
    ...NOT_TRASHED,
  });
  const loans = await openLoans({ customerId: { $in: holders } });

  let deducted = 0;
  let amount = 0;
  for (const loan of loans) {
    const take = await deductForLoan(loan, now);
    if (take > 0) {
      deducted++;
      amount += take;
    }
  }

  if (deducted > 0) logger.info({ deducted, amount }, 'susu loan deductions applied');
  return { loans: loans.length, deducted, amount };
}

let timer: NodeJS.Timeout | null = null;

export function startSusuLoanWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  recordWorkerStart('susu-loan');
  const run = (): void => {
    runSusuLoanPass()
      .then(({ deducted, amount }) => {
        recordWorkerRun('susu-loan', { ok: true, changes: { deducted, amount } });
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'susu loan pass errored');
        recordWorkerRun('susu-loan', { ok: false, error: String(err) });
      });
  };
  run();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopSusuLoanWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
