/**
 * Susu money rules as pure functions — the single source of truth for
 * cycle and commission math. Everything is integer pesewas; these throw
 * on non-integer input rather than silently produce wrong money.
 */

export const SUSU_CYCLE_DEPOSITS = 31;
/** Minimum fixed daily amount when opening an account — GHS 5. */
export const SUSU_MIN_DAILY_AMOUNT = 500;

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

/** Amount for a deposit covering N days. */
export function computeDepositAmount(dailyAmount: number, daysCovered: number): number {
  assertMoneyInt(dailyAmount, 'dailyAmount');
  if (!Number.isInteger(daysCovered) || daysCovered < 1) {
    throw new Error(`daysCovered must be a positive integer, got ${String(daysCovered)}`);
  }
  return dailyAmount * daysCovered;
}

export interface ClosureComputation {
  /** Exactly 1 day's deposit — capped so payout is never negative. */
  commission: number;
  payout: number;
  /** True when deposits didn't even cover the commission (rule: flag, never go negative). */
  flagged: boolean;
}

/**
 * Rule: commission = 1 day's deposit per cycle, taken at payout,
 * regardless of when the customer exits (even day 2).
 */
export function computeClosure(totalDeposited: number, dailyAmount: number): ClosureComputation {
  assertMoneyInt(totalDeposited, 'totalDeposited');
  assertMoneyInt(dailyAmount, 'dailyAmount');
  const commission = Math.min(totalDeposited, dailyAmount);
  return {
    commission,
    payout: totalDeposited - commission,
    flagged: totalDeposited < dailyAmount,
  };
}

export function remainingDeposits(depositsCount: number): number {
  if (
    !Number.isInteger(depositsCount) ||
    depositsCount < 0 ||
    depositsCount > SUSU_CYCLE_DEPOSITS
  ) {
    throw new Error(`depositsCount out of range: ${String(depositsCount)}`);
  }
  return SUSU_CYCLE_DEPOSITS - depositsCount;
}
