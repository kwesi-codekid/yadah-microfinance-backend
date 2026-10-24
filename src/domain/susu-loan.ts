/**
 * The susu loan deduction as pure functions — integer pesewas.
 *
 * Client decisions: a customer's susu loan account (it replaced loan savings)
 * is used for nothing but
 * their loan (6 Oct 2026). The system takes each instalment from it on the
 * loan's own monthly date — counted from the day the loan was taken, not the
 * end of the calendar month (23 Oct 2026): a loan out on 12 Oct is deducted on
 * 12 Nov, 12 Dec, and so on. Nothing is taken on the day the loan goes out.
 *
 * When the account holds less than is due, what is there is taken; and while
 * that month is still short, money paid in later is taken as soon as it
 * arrives rather than waiting for the next monthly date. Once the month is
 * covered, the rest stays in the account until the next date.
 *
 * Those dates are the loan's schedule: buildSchedule (domain/loans.ts) puts
 * instalment n on the disbursement day plus n months, a short month falling
 * back to its last day (31 Jan → 28 Feb).
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface ScheduleLine {
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
}

/** The first instant of the Accra day after `now` — Accra is UTC+0. */
export function endOfDay(now: Date): Date {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(start + DAY_MS);
}

/**
 * What the loan expects to have been paid by the end of today and has not:
 * the instalments falling due by then, less everything paid on the loan's
 * schedule so far. Counted on totals rather than month by month, so payments
 * that never matched a month (an old paper loan's, say) still count — and a
 * loan that is already up to date asks for nothing, however it got there.
 *
 * Once the loan's own due date has passed, everything it still owes is due:
 * escalation raises the total past what the instalments add up to, and that
 * difference belongs to no instalment.
 */
export function amountDueBy(
  loan: { totalDue: number; totalRepaid: number; dueDate?: Date | undefined },
  schedule: readonly ScheduleLine[],
  now: Date,
): number {
  const cutoff = endOfDay(now).getTime();
  const remaining = Math.max(0, loan.totalDue - loan.totalRepaid);
  if (loan.dueDate && loan.dueDate.getTime() < cutoff) return remaining;
  const dueSoFar = schedule
    .filter((line) => line.dueDate.getTime() < cutoff)
    .reduce((sum, line) => sum + line.amountDue, 0);
  const paid = schedule.reduce((sum, line) => sum + line.amountPaid, 0);
  return Math.min(Math.max(0, dueSoFar - paid), remaining);
}

/** What is actually taken: what is due, but no more than the account holds. */
export function deductionAmount(due: number, balance: number): number {
  return Math.max(0, Math.min(due, balance));
}
