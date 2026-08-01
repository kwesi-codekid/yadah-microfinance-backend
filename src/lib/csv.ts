/** Minimal CSV serializer for report downloads. */

function escapeCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let s: string;
  if (value instanceof Date) {
    s = value.toISOString();
  } else if (typeof value === 'string') {
    s = value;
  } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    s = String(value);
  } else {
    s = JSON.stringify(value);
  }
  if (/[",\n\r]/.test(s)) {
    return `"${s.replaceAll('"', '""')}"`;
  }
  return s;
}

/** Header = union of keys across rows, in first-seen order. */
export function toCsv(rows: readonly object[]): string {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const lines = [headers.map(escapeCell).join(',')];
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    lines.push(headers.map((h) => escapeCell(record[h])).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}
