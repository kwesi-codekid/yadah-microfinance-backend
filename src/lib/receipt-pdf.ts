import PDFDocument from 'pdfkit';
import { formatGhs } from './money.js';

/**
 * Printable transaction receipts (client request 2026-08-21).
 *
 * One A4 page per receipt, laid out to stay readable printed in black and
 * white on cheap office paper. Plain pdfkit with built-in Helvetica — no font
 * files, no browser, no network.
 *
 * The receipt is a record of something already committed, never a promise:
 * every figure here is read back from the stored transaction.
 */

const PAGE_WIDTH = 595.28; // A4 portrait width, points
const MARGIN = 42;
const CONTENT_WIDTH = PAGE_WIDTH - MARGIN * 2;
const LABEL_WIDTH = 150;

const INK = '#1a1a1a';
const MUTED = '#666666';
const RULE = '#bbbbbb';
const ACCENT = '#0f5132';

export type ReceiptKind = 'deposit' | 'withdrawal';

export interface ReceiptLine {
  label: string;
  value: string;
  /** Rendered bold — use for the figure that matters on this receipt. */
  emphasis?: boolean;
}

export interface ReceiptData {
  /** Human-quotable reference, e.g. SD-6F3A9C21. */
  receiptNo: string;
  kind: ReceiptKind;
  /** Headline, e.g. 'Susu Deposit' or 'Savings Withdrawal'. */
  title: string;
  customerName: string;
  customerPhone?: string;
  accountNumber: string;
  /** The money the customer handed over or received, in pesewas. */
  amount: number;
  /** Extra rows specific to the product — days covered, fee, balance, etc. */
  lines: ReceiptLine[];
  recordedByName: string;
  at: Date;
  /** Shown small at the foot, e.g. the idempotency key or transaction id. */
  reference?: string;
}

function formatDateTime(d: Date): string {
  // Ghana is UTC+0 year-round, so the UTC clock is the local clock.
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} GMT`;
}

export function buildReceiptPdf(data: ReceiptData): Promise<Buffer> {
  const doc = new PDFDocument({ size: 'A4', margin: MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

  let y = MARGIN;

  function rule(colour = RULE, width = 0.5): void {
    doc
      .save()
      .lineWidth(width)
      .strokeColor(colour)
      .moveTo(MARGIN, y)
      .lineTo(PAGE_WIDTH - MARGIN, y)
      .stroke()
      .restore();
    y += 12;
  }

  // ---------------------------------------------------------------- header
  doc
    .font('Helvetica-Bold')
    .fontSize(17)
    .fillColor(INK)
    .text('YADAH DYNAMIC ENTERPRISE', MARGIN, y);
  y = doc.y + 2;
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('Susu · Savings · Loans · Ghana', MARGIN, y);

  // Receipt number sits top-right, where a counter clerk looks first.
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text('RECEIPT NO.', PAGE_WIDTH - MARGIN - 180, MARGIN, { width: 180, align: 'right' });
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor(INK)
    .text(data.receiptNo, PAGE_WIDTH - MARGIN - 180, MARGIN + 12, { width: 180, align: 'right' });

  y = Math.max(doc.y, MARGIN + 44) + 10;
  rule(ACCENT, 1.5);

  // ---------------------------------------------------------------- title band
  doc
    .font('Helvetica-Bold')
    .fontSize(14)
    .fillColor(ACCENT)
    .text(data.title.toUpperCase(), MARGIN, y);
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(formatDateTime(data.at), MARGIN, y, { width: CONTENT_WIDTH, align: 'right' });
  y = doc.y + 10;
  rule();

  // ---------------------------------------------------------------- the figure
  // The amount is the one thing a customer checks, so it gets its own block.
  const boxHeight = 54;
  doc
    .save()
    .lineWidth(0.8)
    .strokeColor(RULE)
    .rect(MARGIN, y, CONTENT_WIDTH, boxHeight)
    .stroke()
    .restore();
  doc
    .font('Helvetica')
    .fontSize(9)
    .fillColor(MUTED)
    .text(data.kind === 'deposit' ? 'AMOUNT RECEIVED' : 'AMOUNT PAID OUT', MARGIN + 14, y + 11);
  doc
    .font('Helvetica-Bold')
    .fontSize(24)
    .fillColor(INK)
    .text(formatGhs(data.amount), MARGIN + 14, y + 24);
  y += boxHeight + 18;

  // ---------------------------------------------------------------- detail rows
  function row(label: string, value: string, emphasis = false): void {
    const valueWidth = CONTENT_WIDTH - LABEL_WIDTH;
    const font = emphasis ? 'Helvetica-Bold' : 'Helvetica';
    const height = Math.max(
      doc.font(font).fontSize(10).heightOfString(value, { width: valueWidth }),
      12,
    );
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(MUTED)
      .text(label, MARGIN, y, { width: LABEL_WIDTH });
    doc
      .font(font)
      .fontSize(10)
      .fillColor(INK)
      .text(value, MARGIN + LABEL_WIDTH, y, { width: valueWidth });
    y += height + 7;
  }

  row('Customer', data.customerName);
  if (data.customerPhone) row('Phone', data.customerPhone);
  row('Account number', data.accountNumber);
  for (const line of data.lines) row(line.label, line.value, line.emphasis === true);
  row('Recorded by', data.recordedByName);

  y += 6;
  rule();

  // ---------------------------------------------------------------- signatures
  const colWidth = (CONTENT_WIDTH - 30) / 2;
  const signY = y + 34;
  for (const [index, caption] of [
    "Customer's signature",
    'For Yadah Dynamic Enterprise',
  ].entries()) {
    const x = MARGIN + index * (colWidth + 30);
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(RULE)
      .moveTo(x, signY)
      .lineTo(x + colWidth, signY)
      .stroke()
      .restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(caption, x, signY + 5, {
        width: colWidth,
      });
  }
  y = signY + 30;

  // ---------------------------------------------------------------- footer
  doc
    .font('Helvetica')
    .fontSize(8)
    .fillColor(MUTED)
    .text(
      'Keep this receipt as proof of the transaction above. Figures are in Ghana Cedis.',
      MARGIN,
      doc.page.height - MARGIN - 34,
      { width: CONTENT_WIDTH },
    );
  if (data.reference) {
    doc.fontSize(7).text(`Ref: ${data.reference}`, MARGIN, doc.page.height - MARGIN - 14, {
      width: CONTENT_WIDTH,
    });
  }

  doc.end();
  return done;
}

/** Stable, human-quotable receipt number derived from the transaction id. */
export function receiptNumber(prefix: string, id: { toHexString: () => string }): string {
  return `${prefix}-${id.toHexString().slice(-8).toUpperCase()}`;
}
