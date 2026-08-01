import mongoose from 'mongoose';
import { LoanModel } from '../models/index.js';
import { computeInterest, escalationActionFor, type LoanRates } from '../domain/loans.js';
import { audit } from './audit.js';
import { emitAdminEvent } from './realtime.js';
import { logger } from './logger.js';

/**
 * Overdue engine (WBS 5.7). State-based, so any number of runs per day
 * produces the same result: a loan escalates when its AGE passes the months
 * its current rate covers (each rate "buys" its duration's worth of time),
 * lands in arrears + frozen after the top rate's window. New interest is
 * always computed on the ORIGINAL principal.
 */
export async function runEscalationPass(
  rates?: LoanRates,
): Promise<{ escalated: number; frozen: number }> {
  const { getLoanConfig } = await import('../modules/loans/loans.service.js');
  const activeRates = rates ?? (await getLoanConfig()).rates;
  const now = new Date();
  let escalated = 0;
  let frozen = 0;

  const candidates = await LoanModel.find({ status: 'active', frozen: false });
  for (const loan of candidates) {
    const start = loan.disbursedAt ?? loan.approvedAt;
    if (!start) continue;
    const action = escalationActionFor(loan.ratePercent, start, now, activeRates);
    if (!action) continue;

    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        if (action.type === 'escalate') {
          const interestAmount = computeInterest(loan.principal, action.newRatePercent);
          const totalDue = loan.principal + interestAmount;
          const upd = await LoanModel.updateOne(
            { _id: loan._id, status: 'active', ratePercent: loan.ratePercent },
            {
              $set: {
                ratePercent: action.newRatePercent,
                interestAmount,
                totalDue,
                escalatedAt: now,
              },
            },
            { session },
          );
          if (upd.modifiedCount !== 1) return; // concurrent change — next pass re-evaluates
          await audit(
            {
              actorId: loan.customerId, // system action; anchor on the loan's customer
              action: 'loan.escalate',
              entityType: 'loan',
              entityId: loan._id,
              amountBefore: loan.totalDue,
              amountAfter: totalDue,
              after: { fromRate: loan.ratePercent, toRate: action.newRatePercent },
            },
            session,
          );
          escalated++;
          emitAdminEvent('loan.escalated', {
            id: loan._id.toHexString(),
            customerId: loan.customerId.toHexString(),
            fromRate: loan.ratePercent,
            toRate: action.newRatePercent,
            totalDue,
          });
        } else {
          const upd = await LoanModel.updateOne(
            { _id: loan._id, status: 'active', frozen: false },
            { $set: { status: 'arrears', frozen: true } },
            { session },
          );
          if (upd.modifiedCount !== 1) return;
          await audit(
            {
              actorId: loan.customerId,
              action: 'loan.freeze',
              entityType: 'loan',
              entityId: loan._id,
              amountBefore: loan.totalDue,
              amountAfter: loan.totalDue,
              after: { reason: 'escalation exhausted — in arrears' },
            },
            session,
          );
          frozen++;
          emitAdminEvent('loan.arrears', {
            id: loan._id.toHexString(),
            customerId: loan.customerId.toHexString(),
            totalDue: loan.totalDue,
          });
        }
      });
    } finally {
      await session.endSession();
    }
  }

  if (escalated > 0 || frozen > 0) {
    logger.info({ escalated, frozen }, 'loan escalation pass applied changes');
  }
  return { escalated, frozen };
}

let timer: NodeJS.Timeout | null = null;

export function startLoanEscalationWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  const run = (): void => {
    runEscalationPass().catch((err: unknown) => {
      logger.warn({ err }, 'loan escalation pass errored');
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
