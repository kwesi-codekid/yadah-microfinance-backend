import { inflateSync } from 'node:zlib';
import { Types } from 'mongoose';
import { describe, expect, it } from 'vitest';
import {
  buildReceiptPdf,
  receiptNumber,
  type ReceiptData,
  type ReceiptKind,
} from './receipt-pdf.js';

/** pdfkit compresses its content streams, so read the drawn text back out. */
function textOf(buffer: Buffer): string {
  const raw = buffer.toString('latin1');
  let out = '';
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) continue;
    let content: string;
    try {
      content = inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1');
    } catch {
      continue;
    }
    for (const hex of content.matchAll(/<([0-9a-fA-F]+)>/g)) {
      const chars = hex[1] ?? '';
      for (let i = 0; i + 1 < chars.length; i += 2) {
        out += String.fromCharCode(parseInt(chars.slice(i, i + 2), 16));
      }
    }
  }
  return out;
}

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

  it('labels the headline by what the money actually did', async () => {
    const captionOf = async (kind: ReceiptKind): Promise<string> =>
      textOf(await buildReceiptPdf({ ...base, kind }));

    expect(await captionOf('deposit')).toContain('AMOUNT RECEIVED');
    expect(await captionOf('withdrawal')).toContain('AMOUNT PAID OUT');
    // A transfer is neither: nothing crosses the counter, so forcing it into
    // one of the other two would misdescribe what happened.
    expect(await captionOf('transfer')).toContain('AMOUNT MOVED');
  });
});
