/**
 * Susu money rules as pure functions — the single source of truth for
 * cycle and commission math. Everything is integer pesewas; these throw
 * on non-integer input rather than silently produce wrong money.
 */

export const SUSU_CYCLE_DEPOSITS = 31;
/**
 * Minimum fixed daily amount when opening an account — GHS 10 (raised from
 * GHS 5 on 2026-08-21). Gates opening only: accounts already running on a
 * smaller daily amount keep their immutable amount for the rest of the cycle.
 */
export const SUSU_MIN_DAILY_AMOUNT = 1000;

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

/**
 * Money still held by the account: everything paid in, less anything already
 * taken out by partial withdrawals. `totalDeposited` alone is the cycle's
 * running total and never decreases — it is not the balance.
 */
export function susuBalance(totalDeposited: number, withdrawnAmount: number): number {
  assertMoneyInt(totalDeposited, 'totalDeposited');
  assertMoneyInt(withdrawnAmount, 'withdrawnAmount');
  if (withdrawnAmount > totalDeposited) {
    throw new Error(
      `withdrawnAmount ${String(withdrawnAmount)} exceeds totalDeposited ${String(totalDeposited)}`,
    );
  }
  return totalDeposited - withdrawnAmount;
}

/**
 * The most a customer may take while keeping the account open.
 *
 * Commission is exactly one cycle-day's amount, taken once, at closure
 * (client rule, reaffirmed 2026-08-21). For that to stay collectible no
 * matter how much has been withdrawn, one day's amount is reserved in the
 * account until it closes — the same shape as the savings minimum balance.
 */
export function maxPartialWithdrawal(balance: number, dailyAmount: number): number {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(dailyAmount, 'dailyAmount');
  return Math.max(0, balance - dailyAmount);
}

export interface PartialWithdrawalComputation {
  balanceAfter: number;
  /** Still reserved against the closing commission. */
  reserved: number;
}

/**
 * A partial withdrawal moves money out and nothing else: no commission is
 * taken here, and the cycle is untouched — days already paid stay paid.
 * Throws when the amount would eat into the commission reserve; callers map
 * that to an API error.
 */
export function computePartialWithdrawal(
  balance: number,
  dailyAmount: number,
  amount: number,
): PartialWithdrawalComputation {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(dailyAmount, 'dailyAmount');
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');
  const available = maxPartialWithdrawal(balance, dailyAmount);
  if (amount > available) {
    throw new RangeError(`amount exceeds the withdrawable balance (${String(available)})`);
  }
  return { balanceAfter: balance - amount, reserved: dailyAmount };
}

export interface ClosureComputation {
  /** Exactly 1 day's deposit — capped so payout is never negative. */
  commission: number;
  payout: number;
  /** True when the balance didn't even cover the commission (rule: flag, never go negative). */
  flagged: boolean;
}

/**
 * Rule: commission = 1 day's deposit per cycle, taken at closure, regardless
 * of when the customer exits (even day 2) and regardless of how much was
 * already withdrawn along the way. Takes the BALANCE, not the running total.
 */
export function computeClosure(balance: number, dailyAmount: number): ClosureComputation {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(dailyAmount, 'dailyAmount');
  const commission = Math.min(balance, dailyAmount);
  return {
    commission,
    payout: balance - commission,
    flagged: balance < dailyAmount,
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
