import PDFDocument from 'pdfkit';
import { BRAND } from './brand.js';
import { formatAmount } from './money.js';

/**
 * Printable financial statements — the balance sheet and profit and loss.
 *
 * Same house style as receipt-pdf.ts: A4, plain pdfkit, built-in Helvetica, no
 * font files or browser. Where this differs is that a financial statement has
 * real typographic conventions, and they exist because they make the numbers
 * readable rather than because they are traditional:
 *
 *   - amounts sit in a fixed right-aligned column, so digits line up by place
 *     value and the eye can compare magnitudes down the page;
 *   - sub-items are indented under their heading;
 *   - a single rule sits above a subtotal, a DOUBLE rule under a final total —
 *     the long-standing signal for "this figure closes the section";
 *   - negative figures print in parentheses, not with a minus sign, which is
 *     far harder to miss on a photocopy.
 *
 * Everything is laid out to survive being printed in black and white on cheap
 * office paper, so colour is only ever an accent — never the sole carrier of
 * meaning.
 */

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 48;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
/** Width of the right-hand money column. Wide enough for GHS 99,999,999.99. */
const AMOUNT_WIDTH = 110;
const BOTTOM_LIMIT = PAGE_HEIGHT - MARGIN - 40;

const INK = BRAND.ink;
const MUTED = BRAND.muted;
const RULE = BRAND.rule;
/** Letterhead rule and the statement title — the one flash of brand colour. */
const ACCENT = BRAND.coral;
/**
 * Something needs attention: a sheet that does not balance, or a net loss.
 * The same coral, because on screen that is exactly what coral already means.
 */
const ALERT = BRAND.coral;

export interface StatementLine {
  label: string;
  /** Pesewas. Omit for a heading row that carries no figure of its own. */
  amount?: number;
  /** 0 = flush left, 1 = indented under a heading. */
  indent?: 0 | 1;
  /** Rendered bold with a rule above — closes a group. */
  subtotal?: boolean;
  /** Bold with a double rule beneath — closes a section. */
  total?: boolean;
  /** A note rather than a figure, e.g. an accounting policy. */
  muted?: boolean;
}

export interface StatementSection {
  heading: string;
  lines: StatementLine[];
}

export interface StatementData {
  /** e.g. 'BALANCE SHEET'. */
  title: string;
  /** e.g. 'As at 27 August 2026' or 'For the period 1 – 27 August 2026'. */
  periodLabel: string;
  sections: StatementSection[];
  /**
   * The closing figure given its own emphasised block — net profit, or the
   * balance check. Rendered in red when `alert` is set.
   */
  highlight?: { label: string; amount: number; caption?: string; alert?: boolean };
  /** Small print at the foot: accounting policies, disclosures. */
  notes?: string[];
  generatedAt: Date;
}

/**
 * Accounting convention: negatives in parentheses, never a bare minus sign —
 * a leading minus is easy to miss on a photocopy. No currency prefix: the
 * column header says GHS once, so the digits align by place value.
 */
function money(pesewas: number): string {
  return pesewas < 0 ? `(${formatAmount(Math.abs(pesewas))})` : formatAmount(pesewas);
}

function formatDateTime(d: Date): string {
  // Ghana is UTC+0 year-round, so the UTC clock is the local clock.
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} GMT`;
}

export function buildStatementPdf(data: StatementData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

  let y = MARGIN;

  function rule(colour: string = RULE, width = 0.5, from = MARGIN, to = PAGE_WIDTH - MARGIN): void {
    doc
      .save()
      .lineWidth(width)
      .strokeColor(colour)
      .moveTo(from, y)
      .lineTo(to, y)
      .stroke()
      .restore();
  }

  /** Starts a fresh page when the next block would run off the bottom. */
  function ensureSpace(needed: number): void {
    if (y + needed <= BOTTOM_LIMIT) return;
    doc.addPage();
    y = MARGIN;
  }

  // ---------------------------------------------------------------- header
  doc
    .font('Helvetica-Bold')
    .fontSize(16)
    .fillColor(INK)
    .text('YADAH DYNAMIC ENTERPRISE', MARGIN, y);
  y = doc.y + 1;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Susu · Savings · Loans · Ghana', MARGIN, y);
  y = doc.y + 14;

  rule(ACCENT, 1.5);
  y += 14;

  doc.font('Helvetica-Bold').fontSize(15).fillColor(ACCENT).text(data.title, MARGIN, y);
  y = doc.y + 3;
  doc.font('Helvetica').fontSize(10).fillColor(MUTED).text(data.periodLabel, MARGIN, y);
  y = doc.y + 6;

  // Column caption, so the right-hand figures are unambiguous.
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text('GHS', PAGE_WIDTH - MARGIN - AMOUNT_WIDTH, y, {
      width: AMOUNT_WIDTH,
      align: 'right',
    });
  y = doc.y + 6;
  rule();
  y += 12;

  // ---------------------------------------------------------------- sections
  function renderLine(line: StatementLine): void {
    ensureSpace(24);
    const indent = (line.indent ?? 0) * 16;
    const bold = line.subtotal === true || line.total === true;
    const labelWidth = CONTENT_WIDTH - AMOUNT_WIDTH - indent - 10;

    // A rule above a subtotal separates it from the items it sums.
    if (line.subtotal === true || line.total === true) {
      y += 3;
      rule(RULE, 0.5, MARGIN + CONTENT_WIDTH - AMOUNT_WIDTH, PAGE_WIDTH - MARGIN);
      y += 4;
    }

    const font = bold ? 'Helvetica-Bold' : 'Helvetica';
    const size = line.muted === true ? 8.5 : 10;
    doc
      .font(line.muted === true ? 'Helvetica-Oblique' : font)
      .fontSize(size)
      .fillColor(line.muted === true ? MUTED : INK)
      .text(line.label, MARGIN + indent, y, { width: labelWidth });
    const labelHeight = doc.y - y;

    if (line.amount !== undefined) {
      doc
        .font(font)
        .fontSize(size)
        .fillColor(INK)
        .text(money(line.amount), PAGE_WIDTH - MARGIN - AMOUNT_WIDTH, y, {
          width: AMOUNT_WIDTH,
          align: 'right',
        });
    }

    y += Math.max(labelHeight, 12) + 3;

    // Double rule under a section total — the convention for "closes here".
    if (line.total === true) {
      y += 2;
      rule(INK, 0.7, MARGIN + CONTENT_WIDTH - AMOUNT_WIDTH, PAGE_WIDTH - MARGIN);
      y += 2.5;
      rule(INK, 0.7, MARGIN + CONTENT_WIDTH - AMOUNT_WIDTH, PAGE_WIDTH - MARGIN);
      y += 8;
    }
  }

  for (const section of data.sections) {
    ensureSpace(50);
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(INK)
      .text(section.heading.toUpperCase(), MARGIN, y, { characterSpacing: 0.6 });
    y = doc.y + 6;
    for (const line of section.lines) renderLine(line);
    y += 7;
  }

  // ---------------------------------------------------------------- highlight
  if (data.highlight) {
    ensureSpace(76);
    const boxHeight = data.highlight.caption === undefined ? 52 : 66;
    const colour = data.highlight.alert === true ? ALERT : INK;
    doc
      .save()
      .lineWidth(1.2)
      .strokeColor(colour)
      .rect(MARGIN, y, CONTENT_WIDTH, boxHeight)
      .stroke()
      .restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(data.highlight.label.toUpperCase(), MARGIN + 16, y + 12);
    doc
      .font('Helvetica-Bold')
      .fontSize(20)
      .fillColor(colour)
      .text(money(data.highlight.amount), MARGIN + 16, y + 24, {
        width: CONTENT_WIDTH - 32,
        align: 'right',
      });
    if (data.highlight.caption !== undefined) {
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(data.highlight.caption, MARGIN + 16, y + 50, { width: CONTENT_WIDTH - 32 });
    }
    y += boxHeight + 16;
  }

  // ---------------------------------------------------------------- notes
  if (data.notes && data.notes.length > 0) {
    ensureSpace(40);
    // Styled like a section heading, so notes carried to their own page read as
    // a deliberate part of the statement rather than an overflow.
    doc
      .font('Helvetica-Bold')
      .fontSize(10.5)
      .fillColor(INK)
      .text('NOTES TO THE ACCOUNTS', MARGIN, y, { characterSpacing: 0.6 });
    y = doc.y + 6;
    for (const [index, note] of data.notes.entries()) {
      ensureSpace(28);
      doc
        .font('Helvetica')
        .fontSize(8.5)
        .fillColor(MUTED)
        .text(`${String(index + 1)}.  ${note}`, MARGIN, y, { width: CONTENT_WIDTH });
      y = doc.y + 5;
    }
  }

  // ---------------------------------------------------------------- footer
  // Written after all content so the page count is final.
  const range = doc.bufferedPageRange();
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    const footY = PAGE_HEIGHT - MARGIN - 18;
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(RULE)
      .moveTo(MARGIN, footY - 8)
      .lineTo(PAGE_WIDTH - MARGIN, footY - 8)
      .stroke()
      .restore();
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(`Generated ${formatDateTime(data.generatedAt)}`, MARGIN, footY, {
        width: CONTENT_WIDTH / 2,
      });
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text(
        `Page ${String(i - range.start + 1)} of ${String(range.count)}`,
        MARGIN + CONTENT_WIDTH / 2,
        footY,
        { width: CONTENT_WIDTH / 2, align: 'right' },
      );
  }

  doc.end();
  return done;
}
