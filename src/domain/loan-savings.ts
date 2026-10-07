/**
 * The month-end loan savings deduction as pure functions — integer pesewas.
 *
 * Client decision (6 Oct 2026): a customer's loan savings account is used for
 * nothing but their loan, and at the end of every month the system takes from
 * it what the loan expects that month. Choices made on the client's
 * "proceed with the rest": when the account holds less than is due, what is
 * there is taken (a part payment); the deduction runs on the last day of the
 * month; and whatever is left stays in the account.
 */

/**
 * How many days into a new month a missed deduction is still made for the
 * month just ended — a server that was down on the last day catches up. Past
 * that, the month is left alone: a deduction the customer was not expecting
 * weeks later is worse than one the office can make by hand.
 */
export const CATCH_UP_DAYS = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The month, `YYYY-MM`, before the given one. */
export function previousMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${String(y - 1)}-12` : `${String(y)}-${String(m - 1).padStart(2, '0')}`;
}

/**
 * Which month's deduction is due on `today` (an Accra day, `YYYY-MM-DD`): the
 * current month on its last day, the month just ended during the first
 * CATCH_UP_DAYS of the next, and none otherwise.
 */
export function deductionMonth(today: string): string | null {
  const date = new Date(`${today}T00:00:00.000Z`);
  const tomorrow = new Date(date.getTime() + DAY_MS);
  if (tomorrow.getUTCDate() === 1) return today.slice(0, 7);
  if (date.getUTCDate() <= CATCH_UP_DAYS) return previousMonth(today.slice(0, 7));
  return null;
}

/** The first instant after a month (`YYYY-MM`) — Accra is UTC+0. */
export function monthEndExclusive(month: string): Date {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 1));
}

export interface ScheduleLine {
  dueDate: Date;
  amountDue: number;
  amountPaid: number;
}

/**
 * What the loan expects to have been paid by the end of the month and has
 * not: every instalment falling due by then, less what has been paid on it —
 * so arrears from earlier months are caught up too, and a month already paid
 * in cash asks for nothing.
 *
 * Once the loan's own due date has passed, everything it still owes is due:
 * escalation raises the total past what the instalments add up to, and that
 * difference belongs to no instalment.
 */
export function amountDueByMonthEnd(
  loan: { totalDue: number; totalRepaid: number; dueDate?: Date | undefined },
  schedule: readonly ScheduleLine[],
  monthEnd: Date,
): number {
  const remaining = Math.max(0, loan.totalDue - loan.totalRepaid);
  if (loan.dueDate && loan.dueDate.getTime() < monthEnd.getTime()) return remaining;
  const due = schedule
    .filter((line) => line.dueDate.getTime() < monthEnd.getTime())
    .reduce((sum, line) => sum + Math.max(0, line.amountDue - line.amountPaid), 0);
  return Math.min(due, remaining);
}

/** What is actually taken: what is due, but no more than the account holds. */
export function deductionAmount(due: number, balance: number): number {
  return Math.max(0, Math.min(due, balance));
}
