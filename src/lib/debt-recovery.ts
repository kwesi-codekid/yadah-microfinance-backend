import { Types } from 'mongoose';
import {
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  SusuPlanModel,
  type HpAgreement,
  type Loan,
} from '../models/index.js';
import { NOT_TRASHED } from '../models/shared.js';
import { availableToWithdraw } from '../domain/savings.js';
import { maxWithdrawal, type PlanState } from '../domain/susu-plans.js';
import { remainingOn } from '../modules/hire-purchase/hp.service.js';
import { transfer } from '../modules/transfers/transfers.service.js';
import { accraDay } from './time.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import { recordWorkerRun, recordWorkerStart } from './worker-status.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * Auto debt recovery (client rule, 2026-08-04): while a loan or HP agreement
 * is overdue, the customer's own money — susu and savings — is debited toward
 * the remaining balance. Sweep order is least-harm-first:
 *
 *   1. susu — a withdrawal from the balance: no commission, the cycles are
 *      untouched, and the lock for cycles in progress is kept
 *   2. savings — NORMAL withdrawal rules (GHS 10 fee, 1/day, min balance kept)
 *
 * Every step reuses the atomic transfers machinery, so each debit is a real
 * transfer: audited both sides, SMS to the customer, idempotent. Keys are
 * deterministic per (debt, source, Accra day) so overlapping passes replay
 * instead of double-debiting.
 */

/** Well-known system actor for automated money moves. */
export const SYSTEM_ACTOR_ID = '000000000000000000000000';
const systemActor: AccessTokenPayload = { sub: SYSTEM_ACTOR_ID, role: 'admin' };

type Debt = { kind: 'loan'; doc: Loan } | { kind: 'hire-purchase'; doc: HpAgreement };

function debtRemaining(debt: Debt): number {
  return debt.kind === 'loan' ? debt.doc.totalDue - debt.doc.totalRepaid : remainingOn(debt.doc);
}

function toSide(
  debt: Debt,
):
  | { type: 'loan'; loanId: Types.ObjectId }
  | { type: 'hire-purchase'; agreementId: Types.ObjectId } {
  return debt.kind === 'loan'
    ? { type: 'loan', loanId: debt.doc._id }
    : { type: 'hire-purchase', agreementId: debt.doc._id };
}

async function refreshRemaining(debt: Debt): Promise<number> {
  if (debt.kind === 'loan') {
    const fresh = await LoanModel.findById(debt.doc._id);
    return fresh ? fresh.totalDue - fresh.totalRepaid : 0;
  }
  const fresh = await HpAgreementModel.findById(debt.doc._id);
  return fresh ? remainingOn(fresh) : 0;
}

/** One debit attempt; non-fatal failures (limits, races) skip the source. */
async function attempt(
  debt: Debt,
  from: { type: 'susu' | 'savings'; accountId: Types.ObjectId },
  amount: number,
  recovered: { total: number },
): Promise<void> {
  const debtId = debt.doc._id.toHexString();
  const key = `recovery:${debtId}:${from.accountId.toHexString()}:${accraDay()}`;
  try {
    const result = await transfer(systemActor, {
      from,
      to: toSide(debt),
      amount,
      idempotencyKey: key,
    });
    if (!result.replayed && result.transfer.amountCredited > 0) {
      recovered.total += result.transfer.amountCredited;
      logger.info(
        {
          debt: debtId,
          kind: debt.kind,
          from: from.type,
          amount: result.transfer.amountCredited,
        },
        'debt recovery debit applied',
      );
    }
  } catch (err) {
    // Expected skips: 1/day already used, nothing available, concurrent change.
    if (!(err instanceof AppError)) throw err;
  }
}

async function recoverDebt(debt: Debt, recovered: { total: number }): Promise<void> {
  const customerId = debt.doc.customerId;
  let remaining = debtRemaining(debt);
  if (remaining < 1) return;

  // 1. Susu — whatever the balance holds above the lock.
  const susuAccounts = await SusuAccountModel.find({
    customerId,
    status: 'active',
    ...NOT_TRASHED,
  });
  for (const account of susuAccounts) {
    if (remaining < 1) return;
    const plans = await SusuPlanModel.find({ accountId: account._id });
    const states: PlanState[] = plans.map((p) => ({
      planId: p._id.toHexString(),
      dailyAmount: p.dailyAmount,
      paidInCycle: p.paidInCycle,
      cyclesCompleted: p.cyclesCompleted,
      status: p.status,
    }));
    const available = maxWithdrawal(account.balance, states);
    if (available < 1) continue;
    await attempt(
      debt,
      { type: 'susu', accountId: account._id },
      Math.min(available, remaining),
      recovered,
    );
    remaining = await refreshRemaining(debt);
  }

  // 2. Savings — normal withdrawal rules apply (fee, 1/day, min balance).
  const savings = await SavingsAccountModel.find({ customerId, status: 'active', ...NOT_TRASHED });
  for (const account of savings) {
    if (remaining < 1) return;
    const available = availableToWithdraw(account.balance);
    if (available < 1) continue;
    await attempt(
      debt,
      { type: 'savings', accountId: account._id },
      Math.min(available, remaining),
      recovered,
    );
    remaining = await refreshRemaining(debt);
  }
}

export async function runDebtRecoveryPass(): Promise<{ recoveredTotal: number }> {
  const recovered = { total: 0 };
  const now = new Date();

  const overdueLoans = await LoanModel.find({
    $or: [{ status: 'arrears' }, { status: 'active', dueDate: { $lt: now } }],
    ...NOT_TRASHED,
  });
  for (const loan of overdueLoans) {
    await recoverDebt({ kind: 'loan', doc: loan }, recovered);
  }

  const overdueHp = await HpAgreementModel.find({ status: 'in-arrears', ...NOT_TRASHED });
  for (const agreement of overdueHp) {
    await recoverDebt({ kind: 'hire-purchase', doc: agreement }, recovered);
  }

  if (recovered.total > 0) {
    logger.info({ recoveredTotal: recovered.total }, 'debt recovery pass recovered funds');
  }
  return { recoveredTotal: recovered.total };
}

let timer: NodeJS.Timeout | null = null;

export function startDebtRecoveryWorker(intervalMs = 60 * 60 * 1000): void {
  if (timer) return;
  recordWorkerStart('debt-recovery');
  const run = (): void => {
    runDebtRecoveryPass()
      .then((changes) => {
        recordWorkerRun('debt-recovery', { ok: true, changes });
      })
      .catch((err: unknown) => {
        logger.warn({ err }, 'debt recovery pass errored');
        recordWorkerRun('debt-recovery', { ok: false, error: String(err) });
      });
  };
  run();
  timer = setInterval(run, intervalMs);
  timer.unref();
}

export function stopDebtRecoveryWorker(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}
