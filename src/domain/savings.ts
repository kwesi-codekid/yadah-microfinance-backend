/**
 * Savings money rules as pure functions — integer pesewas throughout.
 * Client-confirmed: min deposit GHS 5 · no interest · max 1 withdrawal
 * per Accra day · flat GHS 10 fee per withdrawal (closure included) ·
 * min balance GHS 10 withdrawable only on closure.
 */

import { addMonthsClamped } from './loans.js';

export const MIN_DEPOSIT = 500; // GHS 5 (lowered from GHS 10 on 2026-08-21)
export const WITHDRAWAL_FEE = 1000; // GHS 10 flat, any amount
export const MIN_BALANCE = 1000; // GHS 10 (lowered from GHS 50), released only on closure

/**
 * Fixed deposits (client decision, 6 Oct 2026): a savings account a parent
 * opens for their child, the child holding it and the parent its guardian. No
 * interest. The maturity date is chosen at opening, at least six months out.
 * Until that day every rule above applies — the fee, the floor, one a day.
 * From that day on, money comes out free: no fee and nothing held back.
 * Deposits are taken throughout and never move the date.
 */
export const FIXED_MIN_MONTHS = 6;
/** Eighteen years — a newborn's deposit can run to their majority, not past it. */
export const FIXED_MAX_MONTHS = 216;

/**
 * The term is chosen in months (6, 9, 12…), not as a date (client decision,
 * 6 Oct 2026); the maturity day is worked out from the day it opens, clamped
 * to the end of a short month.
 */
export function maturityAfter(openedOn: string, months: number): string {
  return addMonthsClamped(new Date(`${openedOn}T00:00:00.000Z`), months)
    .toISOString()
    .slice(0, 10);
}

/** The earliest maturity an account opened on `openedOn` may have, `YYYY-MM-DD`. */
export function earliestMaturity(openedOn: string): string {
  return maturityAfter(openedOn, FIXED_MIN_MONTHS);
}

/** Whether withdrawals on `day` are free. Only a fixed deposit ever matures. */
export function isMatured(
  account: { accountType: string; maturesOn?: string | null },
  day: string,
): boolean {
  const { maturesOn } = account;
  return account.accountType === 'fixed' && Boolean(maturesOn) && day >= (maturesOn ?? '');
}

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

/**
 * available = balance − the GHS 10 floor − the GHS 10 fee, floored at zero
 * (rule 4). A matured fixed deposit holds nothing back: all of it.
 */
export function availableToWithdraw(balance: number, matured = false): number {
  assertMoneyInt(balance, 'balance');
  if (matured) return balance;
  return Math.max(0, balance - MIN_BALANCE - WITHDRAWAL_FEE);
}

export interface WithdrawalComputation {
  fee: number;
  /** amount + fee — what leaves the account. */
  totalDebit: number;
  balanceAfter: number;
}

/**
 * amount = what the customer receives; the fee is debited on top.
 * Throws domain errors when the amount is not withdrawable — callers map
 * these to API errors.
 */
export function computeWithdrawal(
  balance: number,
  amount: number,
  matured = false,
): WithdrawalComputation {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');
  const available = availableToWithdraw(balance, matured);
  if (amount > available) {
    throw new RangeError(`amount exceeds available balance (${String(available)})`);
  }
  const fee = matured ? 0 : WITHDRAWAL_FEE;
  const totalDebit = amount + fee;
  return { fee, totalDebit, balanceAfter: balance - totalDebit };
}

export interface SavingsClosureComputation {
  fee: number;
  payout: number;
  /** True when the balance did not even cover the closing fee. */
  flagged: boolean;
}

/**
 * Closure releases the min balance; the flat fee still applies (rule 5) — but
 * not to a matured fixed deposit, which closes free.
 */
export function computeSavingsClosure(balance: number, matured = false): SavingsClosureComputation {
  assertMoneyInt(balance, 'balance');
  const fee = matured ? 0 : Math.min(balance, WITHDRAWAL_FEE);
  return { fee, payout: balance - fee, flagged: !matured && balance < WITHDRAWAL_FEE };
}

/**
 * The loan savings account (client decision, 6 Oct 2026): paid into like any
 * other, but its money is only ever applied to the customer's loan — never
 * withdrawn, so nothing is available to withdraw and no fee or floor applies.
 */
export function isLoanSavings(account: { accountType: string }): boolean {
  return account.accountType === 'loan';
}
