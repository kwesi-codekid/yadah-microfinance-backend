import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { BRAND } from './brand.js';
import { noticeEmailHtml, otpEmailHtml } from './email.js';
import { buildReceiptPdf } from './receipt-pdf.js';
import { buildStatementPdf } from './statement-pdf.js';

/**
 * Every colour a PDF draws with must come from the shared palette.
 *
 * Colours are easy to hardcode by accident and impossible to notice in a diff,
 * so this reads the actual colour operators back out of the rendered file
 * rather than trusting the source.
 */

const toHex = (r: number, g: number, b: number): string =>
  `#${[r, g, b]
    .map((v) =>
      Math.round(v * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('')}`;

/** Every fill and stroke colour set anywhere in the document. */
function coloursIn(buffer: Buffer): Set<string> {
  const raw = buffer.toString('latin1');
  const found = new Set<string>();
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
    for (const t of content.matchAll(/([\d.]+) ([\d.]+) ([\d.]+) (?:scn|SCN)/g)) {
      found.add(toHex(Number(t[1]), Number(t[2]), Number(t[3])));
    }
  }
  return found;
}

const PALETTE = new Set(Object.values(BRAND).map((c) => c.toUpperCase()));

describe('printed documents stay on-palette', () => {
  it('draws a statement using only brand colours', async () => {
    const buffer = await buildStatementPdf({
      title: 'BALANCE SHEET',
      periodLabel: 'As at 27 August 2026',
      generatedAt: new Date('2026-08-27T14:05:00Z'),
      sections: [
        {
          heading: 'Assets',
          lines: [
            { label: 'Cash and bank', amount: 4_235_000 },
            { label: 'TOTAL ASSETS', amount: 4_235_000, total: true },
          ],
        },
      ],
      highlight: { label: 'Balance check', amount: 0, caption: 'The statement balances.' },
      notes: ['All amounts are Ghana cedis.'],
    });
    expect([...coloursIn(buffer)].filter((c) => !PALETTE.has(c))).toEqual([]);
  });

  it('draws the alert state using only brand colours', async () => {
    const buffer = await buildStatementPdf({
      title: 'BALANCE SHEET',
      periodLabel: 'As at 27 August 2026',
      generatedAt: new Date('2026-08-27T14:05:00Z'),
      sections: [{ heading: 'Assets', lines: [{ label: 'Cash', amount: 1 }] }],
      highlight: { label: 'Does not balance', amount: -125_000, alert: true },
    });
    const used = coloursIn(buffer);
    expect([...used].filter((c) => !PALETTE.has(c))).toEqual([]);
    // Attention is carried by the brand coral, as it is on screen.
    expect(used.has(BRAND.coral.toUpperCase())).toBe(true);
  });

  it('draws a receipt using only brand colours', async () => {
    const buffer = await buildReceiptPdf({
      receiptNo: 'SD-6F3A9C21',
      kind: 'deposit',
      title: 'Susu Deposit',
      customerName: 'Ama Mensah',
      accountNumber: 'SU26080142',
      amount: 2_000,
      lines: [{ label: 'Daily amount', value: 'GHS 10.00' }],
      recordedByName: 'Kofi Boateng',
      at: new Date('2026-08-27T09:30:00Z'),
    });
    expect([...coloursIn(buffer)].filter((c) => !PALETTE.has(c))).toEqual([]);
  });

  it('carries the coral letterhead on every document', async () => {
    const receipt = await buildReceiptPdf({
      receiptNo: 'SD-1',
      kind: 'deposit',
      title: 'Susu Deposit',
      customerName: 'Ama Mensah',
      accountNumber: 'SU26080142',
      amount: 2_000,
      lines: [],
      recordedByName: 'Kofi Boateng',
      at: new Date('2026-08-27T09:30:00Z'),
    });
    expect(coloursIn(receipt).has(BRAND.coral.toUpperCase())).toBe(true);
  });

  it('keeps the rule darker than a screen hairline so it survives a photocopy', () => {
    // #C9CED6 is mid-grey; a screen border token like #E5E7EB all but vanishes.
    const channel = Number.parseInt(BRAND.rule.slice(1, 3), 16);
    expect(channel).toBeLessThan(0xdd);
  });

  it('has no source file hardcoding a colour outside the palette', () => {
    for (const file of [
      'src/lib/statement-pdf.ts',
      'src/lib/receipt-pdf.ts',
      'src/lib/email.ts',
      'src/modules/customers/registration-pdf.ts',
    ]) {
      const source = readFileSync(file, 'utf8');
      const hexes = [...source.matchAll(/#[0-9a-fA-F]{6}\b/g)].map((h) => h[0].toUpperCase());
      expect({ file, stray: hexes.filter((h) => !PALETTE.has(h)) }).toEqual({ file, stray: [] });
    }
  });

  it('renders emails using only brand colours', () => {
    for (const html of [
      otpEmailHtml('123456', 'Ama Mensah'),
      noticeEmailHtml('Password changed', 'Your password was changed.', 'Ama Mensah'),
    ]) {
      const hexes = [...html.matchAll(/#[0-9a-fA-F]{6}/g)].map((h) => h[0].toUpperCase());
      expect(hexes.filter((h) => !PALETTE.has(h))).toEqual([]);
      // Every email carries the coral rule, like the printed letterhead.
      expect(hexes).toContain(BRAND.coral.toUpperCase());
    }
  });

  it('tells mail clients not to invert the palette in dark mode', () => {
    // Without this, Apple Mail and Outlook auto-invert the card and coral on
    // white becomes muddy and unreadable.
    const html = otpEmailHtml('123456', 'Ama Mensah');
    expect(html).toContain('name="color-scheme" content="light"');
    expect(html).toContain('name="supported-color-schemes" content="light"');
    expect(html).toContain('color-scheme:light');
  });

  it('escapes nothing away: the code and name still reach the reader', () => {
    const html = otpEmailHtml('482913', 'Ama Mensah');
    expect(html).toContain('482913');
    expect(html).toContain('Ama Mensah');
    // A hidden preheader gives the inbox something better than raw markup.
    expect(html).toContain('mso-hide:all');
  });
});
