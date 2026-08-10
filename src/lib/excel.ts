import ExcelJS from 'exceljs';

/**
 * XLSX serializer for report/listing downloads. Column set mirrors toCsv:
 * union of row keys in first-seen order. Columns named in `moneyKeys` hold
 * integer pesewas and are rendered as GHS decimals — the one place money
 * leaves integer form, strictly at the presentation boundary.
 */
export interface XlsxOptions {
  sheet?: string;
  moneyKeys?: readonly string[];
}

export async function toXlsxBuffer(
  rows: readonly object[],
  opts: XlsxOptions = {},
): Promise<Buffer> {
  const headers: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!headers.includes(key)) headers.push(key);
    }
  }
  const moneyKeys = new Set(opts.moneyKeys ?? []);

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(opts.sheet ?? 'Export');
  sheet.columns = headers.map((h) => ({
    header: moneyKeys.has(h) ? `${h} (GHS)` : h,
    key: h,
    width: Math.max(12, h.length + 6),
  }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: 'frozen', ySplit: 1 }];

  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const cells: Record<string, unknown> = {};
    for (const h of headers) {
      const v = record[h];
      if (v === null || v === undefined) {
        cells[h] = '';
      } else if (moneyKeys.has(h) && typeof v === 'number') {
        cells[h] = v / 100;
      } else if (
        typeof v === 'string' ||
        typeof v === 'number' ||
        typeof v === 'boolean' ||
        v instanceof Date
      ) {
        cells[h] = v;
      } else {
        cells[h] = JSON.stringify(v);
      }
    }
    sheet.addRow(cells);
  }
  for (const h of headers) {
    if (moneyKeys.has(h)) sheet.getColumn(h).numFmt = '#,##0.00';
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
