import { randomInt } from 'node:crypto';
import { CounterModel } from '../models/counter.model.js';
import { AppError } from './errors.js';

/**
 * Account numbers are `PREFIX + YY + MM + NNNN`, e.g. `SU26080001` — the
 * fourth susu account opened in August 2026. The sequence restarts at 1 each
 * month, per product, so the date segment is part of what makes the number
 * unique.
 *
 * Accounts created before this scheme keep their old numbers (susu: 6 random
 * digits, savings: 10) — those are printed on receipts and quoted by
 * customers, so they are grandfathered rather than rewritten. Both shapes are
 * accepted by the model regexes; only new accounts get the new format.
 */

export const ACCOUNT_PREFIXES = {
  susu: 'SU',
  savings: 'SV',
  loan: 'LN',
  'hire-purchase': 'HP',
} as const;

export type AccountPrefix = (typeof ACCOUNT_PREFIXES)[keyof typeof ACCOUNT_PREFIXES];

/** Digits in the per-month sequence — 9,999 accounts per product per month. */
const SEQUENCE_DIGITS = 4;
const SEQUENCE_MAX = 10 ** SEQUENCE_DIGITS - 1;

/** Matches the current format for a given prefix, e.g. /^SU\d{8}$/. */
export function accountNumberPattern(prefix: AccountPrefix): RegExp {
  return new RegExp(`^${prefix}[0-9]{${String(2 + 2 + SEQUENCE_DIGITS)}}$`);
}

/**
 * The `YYMM` segment for a date. Ghana is UTC+0 year-round, so the Accra
 * month and the UTC month are the same (see lib/time.ts).
 */
export function accountPeriodKey(date: Date = new Date()): string {
  return date.toISOString().slice(2, 7).replace('-', ''); // 2026-08-… -> '2608'
}

/** The counter document key backing one product's sequence for one month. */
export function counterKey(prefix: AccountPrefix, period: string): string {
  return `${prefix}-${period}`;
}

/**
 * Reserve the next number in a product's monthly sequence.
 *
 * Runs outside any caller transaction on purpose — see the note on
 * CounterModel. Call it BEFORE opening the session that creates the account,
 * never inside one.
 */
export async function nextAccountNumber(
  prefix: AccountPrefix,
  date: Date = new Date(),
): Promise<string> {
  const period = accountPeriodKey(date);
  // upsert + returnDocument:'after' always yields a document.
  const counter = await CounterModel.findOneAndUpdate(
    { _id: counterKey(prefix, period) },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  const seq = counter.seq;
  if (seq > SEQUENCE_MAX) {
    throw new AppError(
      'ACCOUNT_NUMBER_EXHAUSTED',
      `More than ${String(SEQUENCE_MAX)} ${prefix} accounts opened this month — the numbering scheme needs widening`,
      500,
    );
  }
  return formatAccountNumber(prefix, period, seq);
}

export function formatAccountNumber(prefix: AccountPrefix, period: string, seq: number): string {
  return `${prefix}${period}${String(seq).padStart(SEQUENCE_DIGITS, '0')}`;
}

/**
 * Raise a counter to at least `seq`, so numbers handed out by a backfill are
 * never issued again. Used by the migration script only.
 */
export async function raiseCounter(
  prefix: AccountPrefix,
  period: string,
  seq: number,
): Promise<void> {
  // $max only moves the counter up, so re-running the migration is a no-op.
  await CounterModel.updateOne(
    { _id: counterKey(prefix, period) },
    { $max: { seq } },
    { upsert: true },
  );
}

// ------------------------------------------------------------------ legacy

/**
 * The pre-2026-08 random scheme. Retained only so the historical
 * backfill-account-numbers script still builds — do not use for new accounts.
 */
export function generateAccountNumber(digits: number): string {
  if (!Number.isInteger(digits) || digits < 4 || digits > 12) {
    throw new Error(`unsupported account number length: ${String(digits)}`);
  }
  return String(randomInt(10 ** (digits - 1), 10 ** digits));
}

export const SUSU_ACCOUNT_DIGITS = 6;
export const SAVINGS_ACCOUNT_DIGITS = 10;

/** Legacy shapes still in the database, accepted by the model regexes. */
export const LEGACY_SUSU_PATTERN = /^\d{6}$/;
export const LEGACY_SAVINGS_PATTERN = /^\d{10}$/;
