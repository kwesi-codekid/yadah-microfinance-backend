import { env } from '../config/env.js';
import { AppError } from './errors.js';
import type { AccessTokenPayload } from '../modules/auth/auth.service.js';

/**
 * Recording a susu or savings transaction on the day it actually happened.
 *
 * A stopgap for the data-population stage, and deliberately built to be taken
 * out again: nothing reaches this unless `ALLOW_BACKDATED_ENTRY` is set, so
 * the branch can be closed to backdating by changing one environment variable
 * rather than shipping a release.
 *
 * What a backdate DOES is set the transaction's `createdAt`. That sounds
 * heavy-handed, and it is the point: the daily summary, the collector's day,
 * the cash the office expects at reconciliation, the dashboard series and the
 * ledger all already read that one field, so a transaction placed there lands
 * on the right day everywhere at once. Nothing had to learn a new field, and
 * nothing can be left behind still reading the old one.
 *
 * What it does NOT touch is the `_id`, whose ObjectId carries the second the
 * row was really inserted. So a backdated entry always says two things — the
 * day it happened, and the moment somebody typed it — and the second is not
 * the typist's to edit. The audit entry is stamped at the real time too.
 *
 * Collectors are excluded. The reconciliation module exists so that the cash
 * a collector declares can be checked against the day they collected it, and
 * a collector free to move a deposit out of the day being counted is the one
 * hole that control cannot cover.
 */

/** Far enough back for real history, near enough to catch a mistyped year. */
const MAX_BACKDATE_DAYS = 730;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The instant a transaction is recorded at: now, or the chosen Accra day.
 *
 * The time of day is the clock time it was entered, pasted onto the chosen
 * date. That keeps a total order over several entries made minutes apart —
 * which is what the savings running balance is rebuilt from — and it is
 * honest, because nobody knows what time last Tuesday's deposit was handed
 * over, only which day it was.
 */
export function resolveOccurredAt(actor: AccessTokenPayload, occurredOn: string | undefined): Date {
  const now = new Date();
  if (occurredOn === undefined) return now;

  if (!env.ALLOW_BACKDATED_ENTRY) {
    throw new AppError(
      'BACKDATING_DISABLED',
      'Transactions are recorded on the day they are entered',
      422,
    );
  }
  if (actor.role === 'collector') {
    throw new AppError(
      'FORBIDDEN',
      'A collection is recorded on the day it is taken. Ask the office to date it differently.',
      403,
    );
  }

  const at = new Date(`${occurredOn}T${now.toISOString().slice(11)}`);
  // The schema already insists on YYYY-MM-DD, which still admits the 31st of
  // February. Javascript does not refuse that date — it rolls it forward to
  // the 3rd of March — so the day that comes back out is compared with the
  // day that went in. A date nobody meant must not be quietly corrected into
  // one they did not choose either.
  if (Number.isNaN(at.getTime()) || at.toISOString().slice(0, 10) !== occurredOn) {
    throw new AppError('VALIDATION_ERROR', `${occurredOn} is not a real date`, 400);
  }
  if (at.getTime() > now.getTime()) {
    throw new AppError('DATE_IN_FUTURE', 'A transaction cannot be recorded before it happens', 422);
  }
  if (now.getTime() - at.getTime() > MAX_BACKDATE_DAYS * DAY_MS) {
    throw new AppError(
      'DATE_TOO_OLD',
      `A transaction cannot be dated more than ${String(MAX_BACKDATE_DAYS)} days back — check the year`,
      422,
    );
  }
  return at;
}
