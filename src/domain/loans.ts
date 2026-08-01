/**
 * Loan money rules as pure functions — integer pesewas throughout.
 * Client-confirmed: tiers small 1,000–20,000 / big up to 50,000 GHS;
 * flat interest on principal by duration (3m=10%, 6m=20%, 12m=30%);
 * overdue escalation applies the NEXT tier's rate to the ORIGINAL
 * principal; past 30% the amount freezes and the loan is in arrears.
 */

export interface LoanRates {
  3: number;
  6: number;
  12: number;
}

export interface TierLimits {
  smallMin: number; // pesewas
  smallMax: number;
  bigMax: number;
}

export const DEFAULT_RATES: LoanRates = { 3: 10, 6: 20, 12: 30 };
export const DEFAULT_TIERS: TierLimits = {
  smallMin: 100_000, // GHS 1,000
  smallMax: 2_000_000, // GHS 20,000
  bigMax: 5_000_000, // GHS 50,000
};

export type LoanDuration = 3 | 6 | 12;
export const LOAN_DURATIONS: LoanDuration[] = [3, 6, 12];

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

/** small ≤ smallMax < big ≤ bigMax; outside the range → null (refuse). */
export function tierFor(
  principal: number,
  tiers: TierLimits = DEFAULT_TIERS,
): 'small' | 'big' | null {
  assertMoneyInt(principal, 'principal');
  if (principal >= tiers.smallMin && principal <= tiers.smallMax) return 'small';
  if (principal > tiers.smallMax && principal <= tiers.bigMax) return 'big';
  return null;
}

/** Flat interest on the principal. */
export function computeInterest(principal: number, ratePercent: number): number {
  assertMoneyInt(principal, 'principal');
  if (!Number.isInteger(ratePercent) || ratePercent < 0 || ratePercent > 100) {
    throw new Error(`ratePercent out of range: ${String(ratePercent)}`);
  }
  return Math.round((principal * ratePercent) / 100);
}

/** Month arithmetic with end-of-month clamping (Jan 31 + 1m → Feb 28/29). */
export function addMonthsClamped(date: Date, months: number): Date {
  const day = date.getUTCDate();
  const target = new Date(
    Date.UTC(
      date.getUTCFullYear(),
      date.getUTCMonth() + months,
      1,
      date.getUTCHours(),
      date.getUTCMinutes(),
      date.getUTCSeconds(),
      date.getUTCMilliseconds(),
    ),
  );
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target;
}

export interface ScheduleLine {
  installmentNumber: number;
  dueDate: Date;
  amountDue: number;
}

/**
 * Equal monthly instalments; integer division remainder folds into the
 * LAST instalment so the schedule always sums to exactly totalDue.
 */
export function buildSchedule(totalDue: number, months: number, startDate: Date): ScheduleLine[] {
  assertMoneyInt(totalDue, 'totalDue');
  if (!Number.isInteger(months) || months < 1) {
    throw new Error(`months must be a positive integer, got ${String(months)}`);
  }
  const base = Math.floor(totalDue / months);
  return Array.from({ length: months }, (_, i) => ({
    installmentNumber: i + 1,
    dueDate: addMonthsClamped(startDate, i + 1),
    amountDue: i === months - 1 ? totalDue - base * (months - 1) : base,
  }));
}

/** How many months a rate "covers" — each escalation buys that much time. */
export function monthsCoveredByRate(
  ratePercent: number,
  rates: LoanRates = DEFAULT_RATES,
): LoanDuration {
  const entry = LOAN_DURATIONS.find((d) => rates[d] === ratePercent);
  if (!entry) throw new Error(`no duration maps to rate ${String(ratePercent)}%`);
  return entry;
}

export type EscalationAction =
  { type: 'escalate'; newRatePercent: number } | { type: 'freeze' } | null;

/**
 * Escalation ladder: when a loan's age passes the months its current rate
 * covers, it steps to the next rate (on the ORIGINAL principal). At the top
 * rate, passing 12 months freezes the loan into arrears. The boundary day
 * itself is NOT overdue — only strictly after it.
 */
export function escalationActionFor(
  ratePercent: number,
  startDate: Date,
  now: Date,
  rates: LoanRates = DEFAULT_RATES,
): EscalationAction {
  const covered = monthsCoveredByRate(ratePercent, rates);
  const threshold = addMonthsClamped(startDate, covered);
  if (now.getTime() <= threshold.getTime()) return null;
  const idx = LOAN_DURATIONS.indexOf(covered);
  const next = LOAN_DURATIONS[idx + 1];
  if (next === undefined) return { type: 'freeze' };
  return { type: 'escalate', newRatePercent: rates[next] };
}

export interface InstalmentLike {
  amountDue: number;
  amountPaid: number;
}

/** Allocates a repayment to instalments oldest-first; returns per-line additions. */
export function allocateRepayment(instalments: InstalmentLike[], amount: number): number[] {
  assertMoneyInt(amount, 'amount');
  let left = amount;
  return instalments.map((line) => {
    const owed = Math.max(0, line.amountDue - line.amountPaid);
    const applied = Math.min(owed, left);
    left -= applied;
    return applied;
  });
}
