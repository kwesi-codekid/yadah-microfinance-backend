import { Types } from 'mongoose';
import {
  HpAgreementModel,
  LoanModel,
  SavingsAccountModel,
  SusuAccountModel,
  type HpAgreement,
  type Loan,
} from '../models/index.js';
import { availableToWithdraw } from '../domain/savings.js';
import { remainingOn } from '../modules/hire-purchase/hp.service.js';
import { transfer } from '../modules/transfers/transfers.service.js';
import { accraDay } from './time.js';
import { AppError } from './errors.js';
import { logger } from './logger.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * Auto debt recovery (client rule, 2026-08-04): while a loan or HP agreement
 * is overdue, the customer's own money — susu and savings — is debited toward
 * the remaining balance. Sweep order is least-harm-first:
 *
 *   1. susu pending-payout balances (money already loose)
 *   2. savings — NORMAL withdrawal rules (GHS 10 fee, 1/day, min balance kept)
 *   3. completed susu cycles (stop → commission once → remainder pending)
 *   4. active susu cycles (same — the cycle ends, nothing is forfeited)
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
  amount: number | undefined,
  recovered: { total: number },
): Promise<void> {
  const debtId = debt.doc._id.toHexString();
  const key = `recovery:${debtId}:${from.accountId.toHexString()}:${accraDay()}`;
  try {
    const result = await transfer(systemActor, {
      from,
      to: toSide(debt),
      ...(amount !== undefined ? { amount } : {}),
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

  // 1. Pending-payout susu balances.
  const pending = await SusuAccountModel.find({
    customerId,
    status: 'pending-payout',
    payoutRemaining: { $gt: 0 },
  });
  for (const account of pending) {
    if (remaining < 1) return;
    await attempt(
      debt,
      { type: 'susu', accountId: account._id },
      Math.min(account.payoutRemaining, remaining),
      recovered,
    );
    remaining = await refreshRemaining(debt);
  }

  // 2. Savings — normal withdrawal rules apply (fee, 1/day, min balance).
  const savings = await SavingsAccountModel.find({ customerId, status: 'active' });
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

  // 3 & 4. Completed cycles first, then active ones — stopping takes the
  // one-day commission once; any excess stays pending for the customer.
  for (const status of ['completed', 'active'] as const) {
    const accounts = await SusuAccountModel.find({ customerId, status });
    for (const account of accounts) {
      if (remaining < 1) return;
      await attempt(debt, { type: 'susu', accountId: account._id }, undefined, recovered);
      remaining = await refreshRemaining(debt);
    }
  }
}

export async function runDebtRecoveryPass(): Promise<{ recoveredTotal: number }> {
  const recovered = { total: 0 };
  const now = new Date();

  const overdueLoans = await LoanModel.find({
    $or: [{ status: 'arrears' }, { status: 'active', dueDate: { $lt: now } }],
  });
  for (const loan of overdueLoans) {
    await recoverDebt({ kind: 'loan', doc: loan }, recovered);
  }

  const overdueHp = await HpAgreementModel.find({ status: 'in-arrears' });
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
  const run = (): void => {
    runDebtRecoveryPass().catch((err: unknown) => {
      logger.warn({ err }, 'debt recovery pass errored');
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
