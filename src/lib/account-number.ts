import { randomInt } from 'node:crypto';

/**
 * Cryptographically random account number of exactly `digits` digits
 * (never a leading zero). Uniqueness is enforced by the unique index on
 * the account collections — creators retry on the rare collision.
 */
export function generateAccountNumber(digits: number): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 12) {
    throw new Error(`unsupported account number length: ${String(digits)}`);
  }
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

export const SUSU_ACCOUNT_DIGITS = 6;
export const SAVINGS_ACCOUNT_DIGITS = 10;
