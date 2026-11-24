import mongoose from 'mongoose';
import { LoanModel } from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';
import { arrearsDue } from '../domain/loans.js';
import { audit } from './audit.js';
import { emitAdminEvent } from './realtime.js';
import { logger } from './logger.js';
import { recordWorkerRun, recordWorkerStart } from './worker-status.js';

/**
 * Overdue engine (WBS 5.7). State-based, so any number of runs per day
 * produces the same result.
 *
 * It no longer raises rates: since 22 Nov 2026 (client decision) the office
 * raises a loan's rate itself, from the loan page, once the loan is flagged as
 * due (see `rateIncreaseDue` and `raiseLoanRate`). What stays automatic is
 * arrears: a loan still open past its longest duration from the start is
 * frozen and flagged, whatever rate it carries.
 */
export async function runEscalationPass(): Promise<{ escalated: number; frozen: number }> {
  const now = new Date();
  let frozen = 0;

  const candidates = await LoanModel.find({ status: 'active', frozen: false, ...NOT_TRASHED });
  for (const loan of candidates) {
    // A paper loan may carry its own clock (see paperEscalationStart).
    const start = loan.escalationFrom ?? loan.disbursedAt ?? loan.approvedAt;
    if (!start || !arrearsDue(start, now)) continue;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const upd = await LoanModel.updateOne(
          { _id: loan._id, status: 'active', frozen: false },
          { $set: { status: 'arrears', frozen: true } },
          { session },
        );
        if (upd.modifiedCount !== 1) return;
        await audit(
          {
            actorId: loan.customerId, // system action; anchor on the loan's customer
            action: 'loan.freeze',
            entityType: 'loan',
            entityId: loan._id,
            amountBefore: loan.totalDue,
            amountAfter: loan.totalDue,
            after: { reason: 'past the end of the rate ladder — in arrears' },
          },
          session,
        );
        frozen++;
        emitAdminEvent('loan.arrears', {
          id: loan._id.toHexString(),
          customerId: loan.customerId.toHexString(),
          totalDue: loan.totalDue,
        });
      });
    } finally {
      await session.endSession();
    }
  }

  if (frozen > 0) logger.info({ frozen }, 'loan escalation pass applied changes');
  // `escalated` stays in the result so the worker status shape is unchanged.
  return { escalated: 0, frozen };
}

let timer: NodeJS.Timeout | null = null;

export function startLoanEscalationWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  recordWorkerStart('loan-escalation');
  const run = (): void => {
    runEscalationPass()
      .then((changes) => {
        recordWorkerRun('loan-escalation', { ok: true, changes });
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'loan escalation pass errored');
        recordWorkerRun('loan-escalation', { ok: false, error: String(err) });
      });
  };
  run(); // once at startup, then hourly — idempotent by design
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopLoanEscalationWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
