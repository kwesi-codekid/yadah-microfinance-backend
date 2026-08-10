import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { toXlsxBuffer } from './excel.js';

describe('toXlsxBuffer', () => {
  it('round-trips rows with GHS money conversion and derived columns', async () => {
    const rows = [
      { name: 'Ama', amount: 105_000, note: 'first' },
      { name: 'Kofi', amount: 2_050, extra: true },
    ];
    const buffer = await toXlsxBuffer(rows, { sheet: 'Test', moneyKeys: ['amount'] });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('Test');
    expect(sheet).toBeDefined();

    // Header = union of keys in first-seen order; money column labeled GHS.
    const header = (sheet?.getRow(1).values as unknown[]).slice(1);
    expect(header).toEqual(['name', 'amount (GHS)', 'note', 'extra']);
    expect(sheet?.getRow(1).font.bold).toBe(true);

    // Money cells are pesewas / 100.
    expect(sheet?.getRow(2).getCell(2).value).toBe(1_050);
    expect(sheet?.getRow(3).getCell(2).value).toBe(20.5);
    expect(sheet?.getColumn(2).numFmt).toBe('#,##0.00');
  });
});
