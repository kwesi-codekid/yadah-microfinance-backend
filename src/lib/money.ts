/** Presentation-boundary formatting ONLY. All math stays in integer pesewas. */

export function formatGhs(pesewas: number): string {
  if (!Number.isInteger(pesewas)) throw new Error('formatGhs expects integer pesewas');
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  const whole = Math.floor(abs / 100).toLocaleString('en-GH');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}GHS ${whole}.${frac}`;
}

/**
 * The same figure WITHOUT the currency prefix, for tabular use where a column
 * header already says GHS. Repeating the prefix on every row stops the digits
 * lining up by place value, which is the whole point of a money column.
 */
export function formatAmount(pesewas: number): string {
  if (!Number.isInteger(pesewas)) throw new Error('formatAmount expects integer pesewas');
  const sign = pesewas < 0 ? '-' : '';
  const abs = Math.abs(pesewas);
  const whole = Math.floor(abs / 100).toLocaleString('en-GH');
  const frac = String(abs % 100).padStart(2, '0');
  return `${sign}${whole}.${frac}`;
}
