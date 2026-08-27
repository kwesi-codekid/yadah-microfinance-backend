import { describe, expect, it } from 'vitest';
import { buildStatementPdf } from './statement-pdf.js';

const base = {
  title: 'BALANCE SHEET',
  periodLabel: 'As at 27 August 2026',
  generatedAt: new Date('2026-08-27T14:05:00Z'),
};

/** pdfkit compresses its content streams, so read the text back out. */
async function textOf(buffer: Buffer): Promise<string> {
  const { inflateSync } = await import('node:zlib');
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

describe('buildStatementPdf', () => {
  it('produces a real PDF', async () => {
    const buffer = await buildStatementPdf({
      ...base,
      sections: [{ heading: 'Assets', lines: [{ label: 'Cash and bank', amount: 4_235_000 }] }],
    });
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('prints amounts without a currency prefix, so digits align in the column', async () => {
    const text = await textOf(
      await buildStatementPdf({
        ...base,
        sections: [
          {
            heading: 'Assets',
            lines: [
              { label: 'Cash and bank', amount: 4_235_000 },
              { label: 'Loans receivable', amount: 12_400_000 },
            ],
          },
        ],
      }),
    );
    expect(text).toContain('42,350.00');
    expect(text).toContain('124,000.00');
    // The column header carries the unit; repeating it per row would break
    // place-value alignment.
    expect(text).toContain('GHS');
    expect(text).not.toContain('GHS 42,350.00');
  });

  it('shows negatives in parentheses, never as a bare minus', async () => {
    const text = await textOf(
      await buildStatementPdf({
        ...base,
        sections: [
          { heading: 'Assets', lines: [{ label: 'Less: depreciation', amount: -500_000 }] },
        ],
      }),
    );
    expect(text).toContain('(5,000.00)');
    expect(text).not.toContain('-5,000.00');
  });

  it('renders every label, heading and note', async () => {
    const text = await textOf(
      await buildStatementPdf({
        ...base,
        sections: [
          {
            heading: 'Equity',
            lines: [
              { label: 'Contributed capital', amount: 5_000_000 },
              { label: 'TOTAL EQUITY', amount: 5_000_000, total: true },
            ],
          },
        ],
        highlight: { label: 'Balance check', amount: 0, caption: 'The statement balances.' },
        notes: ['All amounts are Ghana cedis.'],
      }),
    );
    expect(text).toContain('YADAH DYNAMIC ENTERPRISE');
    expect(text).toContain('BALANCE SHEET');
    expect(text).toContain('As at 27 August 2026');
    expect(text).toContain('EQUITY');
    expect(text).toContain('Contributed capital');
    expect(text).toContain('BALANCE CHECK');
    expect(text).toContain('NOTES TO THE ACCOUNTS');
    expect(text).toContain('All amounts are Ghana cedis.');
    expect(text).toContain('Page 1 of 1');
  });

  it('carries a long statement onto more pages rather than off the page', async () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({
      label: `Line item ${String(i + 1)}`,
      amount: (i + 1) * 1_000,
    }));
    const buffer = await buildStatementPdf({ ...base, sections: [{ heading: 'Assets', lines }] });
    const text = await textOf(buffer);
    expect(text).toContain('Line item 90');
    // Footers are stamped after layout, so the count is the real total.
    expect(text).toContain('Page 1 of 3');
    expect(text).toContain('Page 3 of 3');
  });

  it('uses only characters the built-in font can actually draw', async () => {
    // pdfkit's Helvetica silently DROPS typographic apostrophes and dashes,
    // leaving a gap on the page — so the text must survive a round trip.
    const label = 'Held for customers - repayable on demand';
    const text = await textOf(
      await buildStatementPdf({
        ...base,
        sections: [{ heading: 'Liabilities', lines: [{ label, amount: 100 }] }],
      }),
    );
    expect(text).toContain(label);
  });
});
