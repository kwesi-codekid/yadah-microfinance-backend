import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import { buildReceiptPdf, receiptNumber, type ReceiptData } from './receipt-pdf.js';

const base: ReceiptData = {
  receiptNo: 'SD-1A2B3C4D',
  kind: 'deposit',
  title: 'Susu Deposit',
  customerName: 'Ama Mensah',
  customerPhone: '0241234567',
  accountNumber: '482913',
  amount: 2_000,
  lines: [
    { label: 'Daily amount', value: 'GHS 10.00' },
    { label: 'Balance after', value: 'GHS 120.00', emphasis: true },
  ],
  recordedByName: 'Kofi Boateng',
  at: new Date('2026-08-21T09:30:00.000Z'),
  reference: '650000000000000000000001',
};

describe('receiptNumber', () => {
  it('is stable, short and quotable over the counter', () => {
    const id = new Types.ObjectId('650000000000000000abcdef');
    expect(receiptNumber('SD', id)).toBe('SD-00ABCDEF');
    // Same id always produces the same number — a reprint is not a new receipt.
    expect(receiptNumber('SD', id)).toBe(receiptNumber('SD', id));
  });

  it('separates the products by prefix', () => {
    const id = new Types.ObjectId('650000000000000000abcdef');
    expect(receiptNumber('VW', id)).not.toBe(receiptNumber('SD', id));
  });
});

describe('buildReceiptPdf', () => {
  it('renders a real PDF', async () => {
    const buffer = await buildReceiptPdf(base);
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1_000);
  });

  it('renders a withdrawal with a fee without falling over', async () => {
    const buffer = await buildReceiptPdf({
      ...base,
      receiptNo: 'VW-1A2B3C4D',
      kind: 'withdrawal',
      title: 'Savings Withdrawal',
      lines: [
        { label: 'Withdrawal fee', value: 'GHS 10.00' },
        { label: 'Total debited', value: 'GHS 60.00' },
        { label: 'Balance after', value: 'GHS 90.00', emphasis: true },
      ],
    });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('survives missing optional fields and long names', async () => {
    const { customerPhone: _phone, reference: _ref, ...withoutOptionals } = base;
    const buffer = await buildReceiptPdf({
      ...withoutOptionals,
      customerName: 'Abena '.repeat(20).trim(),
      lines: [],
    });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('handles a zero amount', async () => {
    const buffer = await buildReceiptPdf({ ...base, amount: 0 });
    expect(buffer.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });
});
