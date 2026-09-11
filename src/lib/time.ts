/** Ghana is UTC+0 year-round, so Accra day/month == UTC day/month. */

export function accraDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function accraMonthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Inclusive Accra-day range → UTC window. Unlike the reports default window,
 * open ends stay open — listings must not silently truncate.
 */
export function dayWindow(from?: string, to?: string): { start?: Date; end?: Date } {
  return {
    ...(from ? { start: new Date(`${from}T00:00:00.000Z`) } : {}),
    ...(to ? { end: new Date(new Date(`${to}T00:00:00.000Z`).getTime() + DAY_MS) } : {}),
  };
}

/** Mongo `createdAt` filter for an optional inclusive Accra-day range. */
export function createdAtFilter(from?: string, to?: string): Record<string, Date> | null {
  const { start, end } = dayWindow(from, to);
  if (!start && !end) return null;
  return { ...(start ? { $gte: start } : {}), ...(end ? { $lt: end } : {}) };
}

/** How far back an unbounded report window reaches, in days. */
export const DEFAULT_RANGE_DAYS = 30;

export interface DayRange {
  from: string;
  to: string;
  start: Date;
  end: Date;
}

/**
 * Inclusive Accra-day range → UTC window, with both ends always resolved.
 *
 * Reports and the transaction feed differ from listings here: a listing with
 * no dates shows everything, but a report with no dates must still name the
 * period it is reporting on, or the totals are a figure nobody can check. So
 * a missing `to` is today and a missing `from` is `DEFAULT_RANGE_DAYS` before
 * `to` — before *`to`*, not before today, so that asking for a window that
 * ends last March does not quietly return one that starts this year.
 */
export function rangeToWindow(from?: string, to?: string): DayRange {
  const toDay = to ?? accraDay();
  const fromDay =
    from ??
    accraDay(new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() - DEFAULT_RANGE_DAYS * DAY_MS));
  return {
    from: fromDay,
    to: toDay,
    start: new Date(`${fromDay}T00:00:00.000Z`),
    end: new Date(new Date(`${toDay}T00:00:00.000Z`).getTime() + DAY_MS),
  };
}
