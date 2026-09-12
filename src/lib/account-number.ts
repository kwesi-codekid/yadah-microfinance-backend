import { randomInt } from 'node:crypto';
import { CounterModel } from '../models/counter.model.js';
import { AppError } from './errors.js';

/**
 * Account numbers are `PREFIX + YY + MM + NNNN`, e.g. `SU26080001` — the
 * first savings account opened in August 2026. The sequence restarts at 1 each
 * month, per product, so the date segment is part of what makes the number
 * unique.
 *
 * Susu is the exception, and the exception is the whole of the branch's
 * practice (client decision, 12 Sep 2026). A susu customer is assigned ONE
 * number, for life, and their books are separated by MONTH inside it — which
 * is how the manual passbooks have always worked. So a susu number is
 * `STEM + -MMM`: the stem identifies the CUSTOMER and never changes, the
 * `-MMM` names the cycle. Two books opened for one customer in September are
 * both `SU26090009-SEP`, byte for byte, and in October the same customer is
 * `SU26090009-OCT`.
 *
 * That makes a susu number a display identity and NOT a key — several accounts
 * legitimately carry the same one. The unique identifier is the account's
 * `_id`, rendered for people by `accountRef` below.
 *
 * The stem is minted from the monthly sequence the first time a customer opens
 * a susu book, so `YYMM` records when that customer joined and is frozen from
 * then on. `-MMM` is the month the cycle is *called*, which the counter picks
 * when opening and which need not be the month we are in: a book opened on 28
 * August for a customer who thinks of it as September is `SU26080012-SEP`.
 *
 * Accounts created before any of this keep their old numbers (susu: 6 random
 * digits, savings: 10) — those are printed on receipts and quoted by
 * customers, so they are grandfathered rather than rewritten, and a legacy
 * susu number becomes that customer's stem exactly as it stands. All shapes
 * are accepted by the model regexes.
 */

export const ACCOUNT_PREFIXES = {
  susu: 'SU',
  savings: 'SV',
  loan: 'LN',
  'hire-purchase': 'HP',
} as const;

export type AccountPrefix = (typeof ACCOUNT_PREFIXES)[keyof typeof ACCOUNT_PREFIXES];

/**
 * Cycle months, in the three-letter form the branch writes on a passbook.
 * Index order is the calendar's, so `CYCLE_MONTHS[month - 1]` is the lookup.
 */
export const CYCLE_MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;
export type CycleMonth = (typeof CYCLE_MONTHS)[number];

/** The cycle month a date falls in. Ghana is UTC+0, so UTC months are Accra months. */
export function cycleMonthOf(date: Date = new Date()): CycleMonth {
  // getUTCMonth is 0-based, which is exactly the array's indexing.
  const month = CYCLE_MONTHS[date.getUTCMonth()];
  // getUTCMonth only ever returns 0-11, so this cannot fire. The check is
  // what narrows the type; the alternative is an assertion the linter bans.
  if (!month) throw new Error(`impossible month index ${String(date.getUTCMonth())}`);
  return month;
}

/** Only susu cycles are named by month; every other product is just a sequence. */
function acceptsCycleMonth(prefix: AccountPrefix): boolean {
  return prefix === ACCOUNT_PREFIXES.susu;
}

/** Digits in the per-month sequence — 9,999 accounts per product per month. */
const SEQUENCE_DIGITS = 4;
const SEQUENCE_MAX = 10 ** SEQUENCE_DIGITS - 1;

/** A susu stem on its own — `SU26090009`, the part that names the customer. */
export const SUSU_STEM_PATTERN = /^SU[0-9]{8}$/;

/**
 * Put a cycle month on a stem. The stem may be a current-format `SU…` one or a
 * grandfathered 6-digit one; both take a suffix, because the branch's rule is
 * about the customer's number and says nothing about how old it is.
 *
 * Idempotent in the useful direction: a value that already carries a month is
 * re-suffixed from its stem rather than growing a second tail, so callers that
 * are not sure what they hold can pass it straight through.
 */
export function withCycleMonth(stem: string, cycleMonth?: CycleMonth): string {
  const bare = bareAccountNumber(stem);
  return cycleMonth === undefined ? bare : `${bare}-${cycleMonth}`;
}

/**
 * Matches the current format for a given prefix, e.g. /^SU\d{8}(-MMM)?$/.
 * The susu suffix is optional here on purpose: accounts opened before the
 * cycle month existed are still current-format and must keep validating.
 */
export function accountNumberPattern(prefix: AccountPrefix): RegExp {
  const digits = String(2 + 2 + SEQUENCE_DIGITS);
  const suffix = acceptsCycleMonth(prefix) ? `(?:-(?:${CYCLE_MONTHS.join('|')}))?` : '';
  return new RegExp(`^${prefix}[0-9]{${digits}}${suffix}$`);
}

/**
 * The number without its cycle month — what a customer quoting `SU26090005`
 * for an account filed as `SU26090005-SEP` means. Anything else is returned
 * unchanged, so this is safe to call on a legacy number.
 */
export function bareAccountNumber(accountNumber: string): string {
  const cut = accountNumber.indexOf('-');
  return cut === -1 ? accountNumber : accountNumber.slice(0, cut);
}

/** The cycle month written on a number, or undefined when it carries none. */
export function cycleMonthFrom(accountNumber: string): CycleMonth | undefined {
  const cut = accountNumber.indexOf('-');
  if (cut === -1) return undefined;
  const tail = accountNumber.slice(cut + 1);
  return (CYCLE_MONTHS as readonly string[]).includes(tail) ? (tail as CycleMonth) : undefined;
}

/**
 * The human-readable rendering of an account's real identifier: when it was
 * opened, to the second, and four characters of its `_id` —
 * `260912134501-a3f9`.
 *
 * A susu number no longer picks out one book, since a customer's cycles all
 * carry theirs, so every list that can show two at once needs something beside
 * it that always differs. This is that, and it is deliberately shaped nothing
 * like `SU26090009-SEP`: two near-identical strings in adjacent columns would
 * be worse than none.
 *
 * Derived, never stored. The tail matters — a bare timestamp collides whenever
 * two accounts are created in the same second, which a seed loop, two tellers
 * working at once, or one payment overflowing into two books inside a single
 * transaction all manage. An `_id` already carries a timestamp plus a
 * per-process counter for exactly that reason, so this inherits its uniqueness
 * instead of hoping for it.
 */
export function accountRef(id: string, openedAt: Date): string {
  // 2026-09-12T13:45:01.000Z -> 260912134501
  const stamp = openedAt.toISOString().slice(2, 19).replace(/[-:T]/g, '');
  return `${stamp}-${id.slice(-4)}`;
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
  cycleMonth?: CycleMonth,
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
  return formatAccountNumber(prefix, period, seq, cycleMonth);
}

export function formatAccountNumber(
  prefix: AccountPrefix,
  period: string,
  seq: number,
  cycleMonth?: CycleMonth,
): string {
  const base = `${prefix}${period}${String(seq).padStart(SEQUENCE_DIGITS, '0')}`;
  if (cycleMonth === undefined) return base;
  if (!acceptsCycleMonth(prefix)) {
    throw new Error(`${prefix} account numbers do not carry a cycle month`);
  }
  return `${base}-${cycleMonth}`;
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
/**
 * The pre-scheme susu shape, with the cycle month the branch now puts on every
 * number. A grandfathered number becomes its owner's stem exactly as it stands,
 * so `482913-SEP` has to validate as readily as `SU26090009-SEP`.
 */
export const LEGACY_SUSU_PATTERN = new RegExp(`^[0-9]{6}(?:-(?:${CYCLE_MONTHS.join('|')}))?$`);
export const LEGACY_SAVINGS_PATTERN = /^\d{10}$/;
