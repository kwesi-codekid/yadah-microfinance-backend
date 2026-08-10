import PDFDocument from 'pdfkit';
import type { Customer } from '../../models/index.js';

/**
 * Renders a customer's registration record as a printable A4 form. Layout is
 * plain pdfkit (built-in Helvetica, no font files, no browser). The photo is
 * fetched from Cloudinary at render time; any fetch problem degrades to a
 * placeholder box — the PDF itself never fails because of an image.
 */

const PAGE_MARGIN = 50;
const PAGE_WIDTH = 595.28; // A4 portrait, points
const CONTENT_WIDTH = PAGE_WIDTH - PAGE_MARGIN * 2;
const LABEL_WIDTH = 150;
const PHOTO_SIZE = 110;

const INK = '#1a1a1a';
const MUTED = '#666666';
const RULE = '#bbbbbb';

/** Cloudinary stores webp/auto variants; pdfkit embeds only JPEG/PNG. */
function asJpegUrl(url: string): string {
  return url.includes('/upload/') ? url.replace('/upload/', '/upload/f_jpg,q_auto/') : url;
}

async function fetchImage(url: string): Promise<Buffer | null> {
  try {
    const res = await fetch(asJpegUrl(url), { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

function formatDate(d: Date | undefined): string {
  return d ? d.toISOString().slice(0, 10) : '—';
}

type Row = [label: string, value: string | undefined];

export async function buildRegistrationFormPdf(
  customer: Customer,
  registeredByName: string | null,
): Promise<Buffer> {
  const photo = customer.photoUrl ? await fetchImage(customer.photoUrl) : null;

  const doc = new PDFDocument({ size: 'A4', margin: PAGE_MARGIN, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on('data', (chunk: Buffer) => chunks.push(chunk));
  const done = new Promise<Buffer>((resolve) => {
    doc.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });

  // ---------------------------------------------------------------- header
  doc
    .font('Helvetica-Bold')
    .fontSize(18)
    .fillColor(INK)
    .text('YADAH DYNAMIC ENTERPRISE', PAGE_MARGIN, PAGE_MARGIN);
  doc.font('Helvetica').fontSize(11).fillColor(MUTED).text('Customer Registration Form');
  doc.fontSize(9).text(`Generated ${new Date().toISOString().slice(0, 10)}`);

  // Photo (or placeholder) top-right.
  const photoX = PAGE_WIDTH - PAGE_MARGIN - PHOTO_SIZE;
  const photoY = PAGE_MARGIN;
  doc.save().lineWidth(0.8).strokeColor(RULE).rect(photoX, photoY, PHOTO_SIZE, PHOTO_SIZE).stroke();
  if (photo) {
    try {
      doc.image(photo, photoX + 2, photoY + 2, {
        fit: [PHOTO_SIZE - 4, PHOTO_SIZE - 4],
        align: 'center',
        valign: 'center',
      });
    } catch {
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text('Photo unavailable', photoX, photoY + PHOTO_SIZE / 2 - 4, {
          width: PHOTO_SIZE,
          align: 'center',
        });
    }
  } else {
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .text('Photo unavailable', photoX, photoY + PHOTO_SIZE / 2 - 4, {
        width: PHOTO_SIZE,
        align: 'center',
      });
  }
  doc.restore();

  let y = Math.max(doc.y + 16, photoY + PHOTO_SIZE + 16);

  // ---------------------------------------------------------------- sections
  function rule(): void {
    doc
      .save()
      .lineWidth(0.5)
      .strokeColor(RULE)
      .moveTo(PAGE_MARGIN, y)
      .lineTo(PAGE_WIDTH - PAGE_MARGIN, y)
      .stroke()
      .restore();
    y += 10;
  }

  function ensureRoom(needed: number): void {
    if (y + needed > doc.page.height - PAGE_MARGIN - 120) {
      doc.addPage();
      y = PAGE_MARGIN;
    }
  }

  function section(title: string, rows: Row[]): void {
    ensureRoom(40);
    doc
      .font('Helvetica-Bold')
      .fontSize(11)
      .fillColor(INK)
      .text(title.toUpperCase(), PAGE_MARGIN, y);
    y = doc.y + 4;
    rule();
    for (const [label, value] of rows) {
      const text = value?.trim() ? value : '—';
      const valueWidth = CONTENT_WIDTH - LABEL_WIDTH;
      const height = Math.max(
        doc.font('Helvetica').fontSize(10).heightOfString(text, { width: valueWidth }),
        12,
      );
      ensureRoom(height + 6);
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(MUTED)
        .text(label, PAGE_MARGIN, y, {
          width: LABEL_WIDTH - 10,
        });
      doc
        .font('Helvetica')
        .fontSize(10)
        .fillColor(INK)
        .text(text, PAGE_MARGIN + LABEL_WIDTH, y, { width: valueWidth });
      y += height + 6;
    }
    y += 8;
  }

  section('Personal details', [
    ['Full name (as on ID)', customer.fullName],
    ['Date of birth', formatDate(customer.dateOfBirth)],
    ['Gender', customer.gender],
    ['Nationality', customer.nationality],
    ['Marital status', customer.maritalStatus],
    ["Mother's maiden name", customer.mothersMaidenName],
  ]);

  section('Contact', [
    ['Residential address', customer.residentialAddress],
    ['GhanaPost GPS', customer.ghanaPostGps],
    ['Postal address', customer.postalAddress],
    ['Phone', customer.phone],
    ['Alternate phone', customer.altPhone],
    ['Email', customer.email],
  ]);

  section('Identification', [
    ['ID type', customer.identification?.idType],
    ['ID number', customer.identification?.idNumber],
    ['Expiry date', formatDate(customer.identification?.idExpiryDate)],
    ['Place of issue', customer.identification?.idPlaceOfIssue],
    ['ID document images', customer.idDocumentFrontUrl ? 'On file (front and back)' : undefined],
  ]);

  section('Occupation', [
    ['Occupation', customer.occupation],
    ['Employer / business', customer.employerOrBusiness],
    ['Purpose of account', customer.purposeOfAccount],
  ]);

  section('Next of kin', [
    ['Full name', customer.nextOfKin?.fullName],
    ['Relationship', customer.nextOfKin?.relationship],
    ['Phone', customer.nextOfKin?.phone],
    ['Address', customer.nextOfKin?.address],
  ]);

  section('Administration', [
    ['Registered on', formatDate(customer.createdAt)],
    ['Registered by', registeredByName ?? '—'],
    ['Status', customer.status],
    ['Customer ID', customer._id.toHexString()],
  ]);

  // ---------------------------------------------------------------- signatures
  ensureRoom(90);
  y += 20;
  const colWidth = (CONTENT_WIDTH - 40) / 3;
  const signatures = ['Customer signature', 'Registering officer', 'Date'];
  signatures.forEach((label, i) => {
    const x = PAGE_MARGIN + i * (colWidth + 20);
    doc
      .save()
      .lineWidth(0.8)
      .strokeColor(INK)
      .moveTo(x, y + 30)
      .lineTo(x + colWidth, y + 30)
      .stroke()
      .restore();
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(label, x, y + 36, { width: colWidth, align: 'center' });
  });

  doc.end();
  return done;
}
