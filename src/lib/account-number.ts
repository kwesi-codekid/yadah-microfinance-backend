import { randomInt } from 'node:crypto';
import { CounterModel } from '../models/counter.model.js';

/**
 * Account numbers are `PREFIX + YY + MM + NNNN`, e.g. `SU26080001` — the
 * first susu number ever issued, in August 2026. `YYMM` is the month the
 * account was opened; the sequence runs on for the life of the product and
 * never restarts (client decision, 1 Oct 2026: a number that went back to
 * 0001 each month read to customers as starting over). Four digits until the
 * sequence passes 9,999, then it simply grows to five — the numbers issued
 * before the rule changed (August and September 2026 each counted from 1)
 * keep their values, and `YYMM` is what keeps those apart.
 *
 * A susu customer holds ONE account, for life (client decision, 30 Sep 2026),
 * so their susu number is issued once and never changes; `YYMM` records when
 * they joined. The cycle-month suffix that used to separate a customer's
 * books (`-SEP`) is gone with the books: cycles now run inside the one
 * account, on its plans.
 *
 * Accounts created before any of this keep their old numbers (susu: 6 random
 * digits, savings: 10) — those are printed on receipts and quoted by
 * customers, so they are grandfathered rather than rewritten. All shapes are
 * accepted by the model regexes.
 */

export const ACCOUNT_PREFIXES = {
  susu: 'SU',
  savings: 'SV',
  loan: 'LN',
  'hire-purchase': 'HP',
} as const;

export type AccountPrefix = (typeof ACCOUNT_PREFIXES)[keyof typeof ACCOUNT_PREFIXES];

/** The sequence is padded to this many digits, and grows past it rather than stopping. */
const SEQUENCE_DIGITS = 4;

/** Matches the current format for a given prefix: `YYMM` then four or more digits, e.g. /^SU\d{8,}$/. */
export function accountNumberPattern(prefix: AccountPrefix): RegExp {
  const digits = String(2 + 2 + SEQUENCE_DIGITS);
  return new RegExp(`^${prefix}[0-9]{${digits},}$`);
}

/** The `YYMM` and sequence of a current-format number, or null for a legacy one. */
export function parseAccountNumber(
  number: string,
): { prefix: string; period: string; seq: number } | null {
  const m = /^([A-Z]{2})([0-9]{4})([0-9]{4,})$/.exec(number);
  if (!m) return null;
  const [, prefix = '', period = '', seq = ''] = m;
  return { prefix, period, seq: Number(seq) };
}

/**
 * The `YYMM` segment for a date. Ghana is UTC+0 year-round, so the Accra
 * month and the UTC month are the same (see lib/time.ts).
 */
export function accountPeriodKey(date: Date = new Date()): string {
  return date.toISOString().slice(2, 7).replace('-', ''); // 2026-08-… -> '2608'
}

/**
 * The counter document key backing one product's sequence — one per product,
 * for life. (Until 1 Oct 2026 there was one per product per month, keyed
 * `SU-2608`; those documents are left behind, unread.)
 */
export function counterKey(prefix: AccountPrefix): string {
  return prefix;
}

/**
 * Reserve the next number in a product's sequence. `date` only sets the
 * `YYMM` segment — when the account was opened; the sequence is the product's.
 *
 * Runs outside any caller transaction on purpose — see the note on
 * CounterModel. Call it BEFORE opening the session that creates the account,
 * never inside one.
 */
export async function nextAccountNumber(
  prefix: AccountPrefix,
  date: Date = new Date(),
): Promise<string> {
  // upsert + returnDocument:'after' always yields a document.
  const counter = await CounterModel.findOneAndUpdate(
    { _id: counterKey(prefix) },
    { $inc: { seq: 1 } },
    { upsert: true, returnDocument: 'after' },
  );
  return formatAccountNumber(prefix, accountPeriodKey(date), counter.seq);
}

export function formatAccountNumber(prefix: AccountPrefix, period: string, seq: number): string {
  return `${prefix}${period}${String(seq).padStart(SEQUENCE_DIGITS, '0')}`;
}

/**
 * Raise a product's counter to at least `seq`, so numbers handed out by a
 * backfill are never issued again. Used by the migration scripts only.
 */
export async function raiseCounter(prefix: AccountPrefix, seq: number): Promise<void> {
  // $max only moves the counter up, so re-running a migration is a no-op.
  await CounterModel.updateOne({ _id: counterKey(prefix) }, { $max: { seq } }, { upsert: true });
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
export const LEGACY_SUSU_PATTERN = /^[0-9]{6}$/;
export const LEGACY_SAVINGS_PATTERN = /^\d{10}$/;
