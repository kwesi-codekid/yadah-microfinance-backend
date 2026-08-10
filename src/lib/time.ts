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
