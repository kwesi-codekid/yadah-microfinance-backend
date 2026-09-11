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

/**
 * How many follow-on accounts one payment may open.
 *
 * One. The real case is a catch-up that overshoots the end of a cycle by a few
 * days. A single payment worth more than two full cycles is far likelier a
 * typo at the counter — 6200000 keyed for 62000 — than cash somebody actually
 * handed over, and quietly opening three accounts on a typo is worse than
 * refusing it and asking. The split below still returns a list, so raising
 * this is a one-constant change.
 */
export const SUSU_MAX_CARRY_ACCOUNTS = 1;

export interface CycleAllocation {
  /** 0 is the account the payment was recorded against; 1.. are new accounts. */
  index: number;
  daysCovered: number;
  /** 1-based position within that account's own 31-day cycle. */
  seqStart: number;
  seqEnd: number;
  /** True when this chunk lands exactly on day 31 of its account. */
  completesCycle: boolean;
}

/**
 * Split a payment that runs past the end of a cycle.
 *
 * The first chunk fills the account it was paid into up to 31 days; each
 * further chunk is a fresh 31-day cycle in a new account. Every chunk
 * therefore satisfies the deposit model's 1..31 bounds on its own, with no
 * schema change — a 40-day payment against an account with 5 days paid splits
 * [26, 14], not [26, 31, 14].
 *
 * The chunks always sum to `daysCovered`. That invariant is the money rule,
 * and the caller re-checks it against the cash before committing.
 */
export function splitAcrossCycles(depositsCount: number, daysCovered: number): CycleAllocation[] {
  const first = remainingDeposits(depositsCount);
  if (!Number.isInteger(daysCovered) || daysCovered < 1) {
    throw new Error(`daysCovered must be a positive integer, got ${String(daysCovered)}`);
  }
  if (first === 0) {
    // An account at 31 is 'completed', never 'active', so the service refuses
    // it well before here. Guard anyway rather than emit a zero-day chunk.
    throw new Error('the cycle is already full — nothing can be recorded against it');
  }

  const out: CycleAllocation[] = [];
  let left = daysCovered;
  let index = 0;
  while (left > 0) {
    const capacity = index === 0 ? first : SUSU_CYCLE_DEPOSITS;
    const take = Math.min(left, capacity);
    const seqStart = index === 0 ? depositsCount + 1 : 1;
    const seqEnd = seqStart + take - 1;
    out.push({
      index,
      daysCovered: take,
      seqStart,
      seqEnd,
      completesCycle: seqEnd === SUSU_CYCLE_DEPOSITS,
    });
    left -= take;
    index += 1;
  }
  return out;
}

/** Follow-on accounts a split implies. Zero on the ordinary path. */
export function carriedAccountCount(allocations: CycleAllocation[]): number {
  return Math.max(0, allocations.length - 1);
}
