/**
 * Savings money rules as pure functions — integer pesewas throughout.
 * Client-confirmed: min deposit GHS 10 · no interest · max 1 withdrawal
 * per Accra day · flat GHS 10 fee per withdrawal (closure included) ·
 * min balance GHS 50 withdrawable only on closure.
 */

export const MIN_DEPOSIT = 1000; // GHS 10
export const WITHDRAWAL_FEE = 1000; // GHS 10 flat, any amount
export const MIN_BALANCE = 5000; // GHS 50, released only on closure

function assertMoneyInt(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer (pesewas), got ${String(value)}`);
  }
}

/** available = balance − 50 − 10, floored at zero (rule 4). */
export function availableToWithdraw(balance: number): number {
  assertMoneyInt(balance, 'balance');
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
export function computeWithdrawal(balance: number, amount: number): WithdrawalComputation {
  assertMoneyInt(balance, 'balance');
  assertMoneyInt(amount, 'amount');
  if (amount < 1) throw new Error('amount must be at least 1 pesewa');
  const available = availableToWithdraw(balance);
  if (amount > available) {
    throw new RangeError(`amount exceeds available balance (${String(available)})`);
  }
  const totalDebit = amount + WITHDRAWAL_FEE;
  return { fee: WITHDRAWAL_FEE, totalDebit, balanceAfter: balance - totalDebit };
}

export interface SavingsClosureComputation {
  fee: number;
  payout: number;
  /** True when the balance did not even cover the closing fee. */
  flagged: boolean;
}

/** Closure releases the min balance; the flat fee still applies (rule 5). */
export function computeSavingsClosure(balance: number): SavingsClosureComputation {
  assertMoneyInt(balance, 'balance');
  const fee = Math.min(balance, WITHDRAWAL_FEE);
  return { fee, payout: balance - fee, flagged: balance < WITHDRAWAL_FEE };
}
