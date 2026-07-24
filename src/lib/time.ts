/** Ghana is UTC+0 year-round, so Accra day/month == UTC day/month. */

export function accraDay(date: Date = new Date()): string {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD
}

export function accraMonthKey(date: Date = new Date()): string {
  return date.toISOString().slice(0, 7); // YYYY-MM
}
