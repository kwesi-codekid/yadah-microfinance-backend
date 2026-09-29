import { AppError } from '../../lib/errors.js';
import { formatGhs } from '../../lib/money.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import {
  MAX_IMPORT_ROWS,
  SheetLayout,
  cedisToPesewas,
  normalizeDay,
  plain,
  readSheet,
  wholeNumber,
  type SheetColumn,
  type SheetFile,
} from '../../lib/sheet-import.js';
import { CustomerModel, LoanModel } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import { normalizeGhanaPhone } from '../../schemas/common.js';
import { computeInterest } from '../../domain/loans.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { OPEN_LOAN_STATUSES } from './loans.service.js';
import { paperLoanBody, type PaperLoanBody } from './loans.schemas.js';
import { recordPaperLoan } from './paper-loans.service.js';

/**
 * Copying the paper loan book in from a spreadsheet.
 *
 * One sheet, one row per payment. A loan is the rows that share a paper
 * number: its first row carries the loan — customer, amount, months, the rate
 * owed now, the day the money went out — and every row may carry one
 * payment, dated, and one guarantor. A loan nobody has paid on yet is a single
 * row with the payment cells empty. That keeps the sheet one flat table, which
 * is what the office can fill in by hand from the paper.
 *
 * The borrower is found by phone number, so they must be registered first
 * (the customer import does that in bulk). Nothing is written by the preview;
 * the commit checks everything again and records loan by loan, so one bad
 * loan never holds up the rest.
 */

export const IMPORT_FIELDS = [
  'paperRef',
  'customerPhone',
  'customerName',
  'principal',
  'durationMonths',
  'ratePercent',
  'disbursedOn',
  'guarantorName',
  'guarantorPhone',
  'guarantorIdNumber',
  'paidOn',
  'amountPaid',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export const IMPORT_COLUMNS: readonly SheetColumn<ImportField>[] = [
  {
    field: 'paperRef',
    header: 'Paper no',
    required: true,
    aliases: ['paper number', 'paper ref', 'form no', 'form number', 'loan no', 'ref'],
    example: 'P-0001',
  },
  {
    field: 'customerPhone',
    header: 'Customer phone',
    required: true,
    aliases: ['phone', 'borrower phone', 'customer phone number'],
    example: '0241234567',
  },
  {
    field: 'customerName',
    header: 'Customer name',
    aliases: ['name', 'borrower', 'customer'],
    example: 'Ama Serwaa',
  },
  {
    field: 'principal',
    header: 'Amount borrowed',
    required: true,
    aliases: ['principal', 'amount', 'loan amount', 'amount ghs'],
    example: '3000',
  },
  {
    field: 'durationMonths',
    header: 'Months',
    required: true,
    aliases: ['duration', 'term', 'duration months'],
    example: '6',
  },
  {
    field: 'ratePercent',
    header: 'Rate now %',
    required: true,
    aliases: ['rate', 'interest', 'interest rate', 'rate now', 'rate %'],
    example: '20',
  },
  {
    field: 'disbursedOn',
    header: 'Date given',
    required: true,
    aliases: ['date', 'disbursed', 'date disbursed', 'disbursement date', 'given on'],
    example: '15/03/2026',
  },
  {
    field: 'guarantorName',
    header: 'Guarantor name',
    aliases: ['guarantor'],
    example: 'Kofi Mensah',
  },
  { field: 'guarantorPhone', header: 'Guarantor phone', example: '0551234567' },
  {
    field: 'guarantorIdNumber',
    header: 'Guarantor ID',
    aliases: ['guarantor id number'],
    example: '',
  },
  {
    field: 'paidOn',
    header: 'Payment date',
    aliases: ['paid on', 'date paid', 'repayment date'],
    example: '15/04/2026',
  },
  {
    field: 'amountPaid',
    header: 'Payment amount',
    aliases: ['paid', 'amount paid', 'repayment', 'repayment amount'],
    example: '600',
  },
];

export { MAX_IMPORT_ROWS };

const layout = new SheetLayout(IMPORT_COLUMNS);

/** The fields that describe the loan itself, as opposed to one payment. */
const LOAN_FIELDS: readonly ImportField[] = [
  'customerPhone',
  'principal',
  'durationMonths',
  'ratePercent',
  'disbursedOn',
];

const LABEL: Record<ImportField, string> = Object.fromEntries(
  IMPORT_COLUMNS.map((c) => [c.field, c.header]),
) as Record<ImportField, string>;

// ---------------------------------------------------------------- shapes

export interface RowIssue {
  field: ImportField | null;
  message: string;
}

export interface PreviewRow {
  row: number;
  values: Record<ImportField, string>;
  issues: RowIssue[];
}

export interface PreviewLoan {
  paperRef: string;
  /** The sheet rows this loan was read from, first row first. */
  rows: number[];
  customerId: string | null;
  customerName: string | null;
  principal: number | null;
  totalDue: number | null;
  totalRepaid: number;
  payments: number;
  status: 'active' | 'repaid' | null;
  /** Whatever stops this loan being recorded. Empty means ready. */
  issues: string[];
}

export interface ImportPreview {
  rows: PreviewRow[];
  loans: PreviewLoan[];
  unknownHeaders: string[];
  counts: { loans: number; ready: number; blocked: number; payments: number };
}

// ---------------------------------------------------------------- validation

interface Group {
  paperRef: string;
  rows: PreviewRow[];
}

function phoneKey(raw: string): string {
  return normalizeGhanaPhone(raw.trim());
}

/**
 * Check the rows and gather them into loans. Pure reading: the customers and
 * the paper numbers already on the books are looked up, nothing is written.
 */
export async function validateRows(
  parsed: { row: number; values: Record<ImportField, string> }[],
  unknownHeaders: string[] = [],
): Promise<{ preview: ImportPreview; bodies: Map<string, PaperLoanBody> }> {
  const rows: PreviewRow[] = parsed.map((r) => ({ ...r, issues: [] }));

  // Gather by paper number, in the order the sheet first names each.
  const groups = new Map<string, Group>();
  for (const row of rows) {
    const ref = row.values.paperRef.trim();
    if (ref === '') {
      row.issues.push({
        field: 'paperRef',
        message: 'Paper no is required — it groups the rows of a loan',
      });
      continue;
    }
    const group = groups.get(ref) ?? { paperRef: ref, rows: [] };
    group.rows.push(row);
    groups.set(ref, group);
  }

  // Everything that needs the database, in one read each.
  const phones = new Set<string>();
  for (const g of groups.values()) {
    const phone = g.rows[0]?.values.customerPhone ?? '';
    if (phone.trim() !== '') phones.add(phoneKey(phone));
  }
  const [customers, entered] = await Promise.all([
    CustomerModel.find({ phone: { $in: [...phones] }, ...NOT_TRASHED }, { fullName: 1, phone: 1 }),
    LoanModel.find({ paperRef: { $in: [...groups.keys()] }, ...NOT_TRASHED }, { paperRef: 1 }),
  ]);
  const byPhone = new Map(customers.map((c) => [c.phone, c]));
  const alreadyEntered = new Set(entered.map((l) => l.paperRef));

  const bodies = new Map<string, PaperLoanBody>();
  const loans: PreviewLoan[] = [];
  /** Customers with an open loan in this sheet, to catch two at once. */
  const openInSheet = new Map<string, string>();
  const candidates: { group: Group; body: PaperLoanBody; loan: PreviewLoan }[] = [];

  for (const group of groups.values()) {
    const [first, ...rest] = group.rows;
    if (!first) continue;
    const loan: PreviewLoan = {
      paperRef: group.paperRef,
      rows: group.rows.map((r) => r.row),
      customerId: null,
      customerName: null,
      principal: null,
      totalDue: null,
      totalRepaid: 0,
      payments: 0,
      status: null,
      issues: [],
    };
    loans.push(loan);

    if (alreadyEntered.has(group.paperRef)) {
      loan.issues.push(`Paper loan ${group.paperRef} has already been entered`);
    }

    // Later rows are payments; loan cells on them must agree with the first.
    for (const row of rest) {
      for (const field of LOAN_FIELDS) {
        const v = row.values[field].trim();
        if (v !== '' && v !== first.values[field].trim()) {
          row.issues.push({
            field,
            message: `${LABEL[field]} differs from row ${String(first.row)}, the first row of ${group.paperRef}`,
          });
        }
      }
    }

    // The borrower.
    const phoneCell = first.values.customerPhone.trim();
    const customer = phoneCell === '' ? undefined : byPhone.get(phoneKey(phoneCell));
    if (phoneCell === '') {
      first.issues.push({ field: 'customerPhone', message: 'Customer phone is required' });
    } else if (!customer) {
      first.issues.push({
        field: 'customerPhone',
        message: `No customer with phone ${phoneCell} — register them first`,
      });
    } else {
      loan.customerId = customer._id.toHexString();
      loan.customerName = customer.fullName;
    }

    // The payments, one per row that has either cell filled in.
    const repayments: { paidOn: string; amount: number }[] = [];
    for (const row of group.rows) {
      const day = normalizeDay(row.values.paidOn);
      const amount = cedisToPesewas(row.values.amountPaid);
      if (day === undefined && amount === undefined) continue;
      if (day === undefined) {
        row.issues.push({ field: 'paidOn', message: 'A payment needs its date' });
        continue;
      }
      if (amount === undefined || Number.isNaN(amount) || amount <= 0) {
        row.issues.push({ field: 'amountPaid', message: 'A payment needs an amount above zero' });
        continue;
      }
      repayments.push({ paidOn: day, amount });
    }

    // Guarantors, like payments: any row may name one, the first row's first.
    const guarantors: { fullName: string; phone: string; idNumber?: string }[] = [];
    for (const row of group.rows) {
      const fullName = plain(row.values.guarantorName);
      const phone = plain(row.values.guarantorPhone);
      const idNumber = plain(row.values.guarantorIdNumber);
      if (fullName === undefined && phone === undefined && idNumber === undefined) continue;
      if (fullName === undefined || phone === undefined) {
        row.issues.push({
          field: fullName === undefined ? 'guarantorName' : 'guarantorPhone',
          message: 'A guarantor needs both a name and a phone',
        });
        continue;
      }
      guarantors.push({ fullName, phone, ...(idNumber !== undefined ? { idNumber } : {}) });
    }

    const parsedBody = paperLoanBody.safeParse({
      customerId: loan.customerId ?? '000000000000000000000000',
      principal: cedisToPesewas(first.values.principal),
      durationMonths: wholeNumber(first.values.durationMonths),
      ratePercent: wholeNumber(first.values.ratePercent.replace('%', '')),
      disbursedOn: normalizeDay(first.values.disbursedOn),
      guarantors,
      repayments,
      paperRef: group.paperRef,
    });
    if (!parsedBody.success) {
      for (const issue of parsedBody.error.issues) {
        const field = fieldForPath(issue.path);
        first.issues.push({
          field,
          message: field ? `${LABEL[field]}: ${friendly(field, issue.message)}` : issue.message,
        });
      }
      continue;
    }

    const body = parsedBody.data;
    const totalDue = body.principal + computeInterest(body.principal, body.ratePercent);
    const totalRepaid = body.repayments.reduce((s, p) => s + p.amount, 0);
    loan.principal = body.principal;
    loan.totalDue = totalDue;
    loan.totalRepaid = totalRepaid;
    loan.payments = body.repayments.length;
    loan.status = totalRepaid >= totalDue ? 'repaid' : 'active';

    const today = new Date().toISOString().slice(0, 10);
    if (body.disbursedOn > today) loan.issues.push('Date given is in the future');
    for (const p of body.repayments) {
      if (p.paidOn > today) loan.issues.push(`A payment is dated ${p.paidOn}, in the future`);
      if (p.paidOn < body.disbursedOn) {
        loan.issues.push(
          `A payment on ${p.paidOn} is before the money was given (${body.disbursedOn})`,
        );
      }
    }
    if (totalRepaid > totalDue) {
      loan.issues.push(
        `Payments add up to ${formatGhs(totalRepaid)}, more than the ${formatGhs(totalDue)} owed`,
      );
    }
    if (loan.status === 'active' && loan.customerId) {
      const other = openInSheet.get(loan.customerId);
      if (other) {
        loan.issues.push(
          `${loan.customerName ?? 'This customer'} also has open loan ${other} in this sheet — only one may be open`,
        );
      } else {
        openInSheet.set(loan.customerId, group.paperRef);
      }
    }
    candidates.push({ group, body, loan });
  }

  // Open loans already on the books, for the customers who would get another.
  const openIds = [...openInSheet.keys()];
  if (openIds.length > 0) {
    const open = await LoanModel.find(
      { customerId: { $in: openIds }, status: { $in: OPEN_LOAN_STATUSES }, ...NOT_TRASHED },
      { customerId: 1 },
    );
    const hasOpen = new Set(open.map((l) => l.customerId.toHexString()));
    for (const { loan } of candidates) {
      if (loan.status === 'active' && loan.customerId && hasOpen.has(loan.customerId)) {
        loan.issues.push(`${loan.customerName ?? 'This customer'} already has an open loan`);
      }
    }
  }

  for (const { group, body, loan } of candidates) {
    const rowIssues = group.rows.some((r) => r.issues.length > 0);
    if (!rowIssues && loan.issues.length === 0) bodies.set(group.paperRef, body);
  }
  // A loan blocked by one of its rows says so, so the loans list is enough to read.
  for (const loan of loans) {
    const bad = rows.filter((r) => loan.rows.includes(r.row) && r.issues.length > 0);
    for (const r of bad) {
      for (const issue of r.issues) loan.issues.push(`Row ${String(r.row)}: ${issue.message}`);
    }
  }

  const ready = loans.filter((l) => l.issues.length === 0).length;
  return {
    preview: {
      rows,
      loans,
      unknownHeaders,
      counts: {
        loans: loans.length,
        ready,
        blocked: loans.length - ready,
        payments: loans.reduce((s, l) => s + l.payments, 0),
      },
    },
    bodies,
  };
}

/** Which column a schema complaint belongs to, from the path it names. */
const PATH_FIELDS: Record<string, ImportField> = {
  principal: 'principal',
  durationMonths: 'durationMonths',
  ratePercent: 'ratePercent',
  disbursedOn: 'disbursedOn',
  paperRef: 'paperRef',
  'guarantors.fullName': 'guarantorName',
  'guarantors.phone': 'guarantorPhone',
  'guarantors.idNumber': 'guarantorIdNumber',
  'repayments.paidOn': 'paidOn',
  'repayments.amount': 'amountPaid',
};

function fieldForPath(path: readonly PropertyKey[]): ImportField | null {
  const key = path.filter((p) => typeof p === 'string').join('.');
  return PATH_FIELDS[key] ?? null;
}

/** Zod's words for the cells people most often get wrong, in the office's words. */
function friendly(field: ImportField, message: string): string {
  if (field === 'durationMonths') return 'must be 3, 6 or 12';
  if (field === 'ratePercent') return 'must be 10, 20 or 30';
  if (field === 'disbursedOn' || field === 'paidOn') return 'must be a date like 15/03/2026';
  if (field === 'principal') return 'must be an amount in cedis, like 3000';
  return message;
}

/** Read an uploaded sheet and check it. Writes nothing. */
export async function previewImportFile(file: SheetFile): Promise<ImportPreview> {
  const { rows, unknownHeaders } = await readSheet(file, layout);
  return (await validateRows(rows, unknownHeaders)).preview;
}

// ---------------------------------------------------------------- writing

export interface ImportOutcome {
  created: { paperRef: string; id: string; customerName: string | null }[];
  failed: { paperRef: string; rows: number[]; issues: string[] }[];
  counts: { total: number; created: number; failed: number };
}

/**
 * Record the loans the office accepted, loan by loan. The sheet is checked
 * again first — the preview may have sat open while somebody else entered a
 * loan — and what fails comes back with its reason.
 */
export async function importPaperLoans(
  actor: AccessTokenPayload,
  input: { row?: number | undefined; values: Record<string, string> }[],
  requestId?: string,
): Promise<ImportOutcome> {
  if (input.length === 0) throw new AppError('EMPTY_IMPORT', 'No rows were sent', 422);
  if (input.length > MAX_IMPORT_ROWS) {
    throw new AppError(
      'TOO_MANY_ROWS',
      `${String(MAX_IMPORT_ROWS)} rows is the most one import may carry`,
      422,
    );
  }
  const { preview, bodies } = await validateRows(
    input.map((r, i) => ({ row: r.row ?? i + 2, values: { ...layout.blankRow(), ...r.values } })),
  );

  const created: ImportOutcome['created'] = [];
  const failed: ImportOutcome['failed'] = [];
  for (const loan of preview.loans) {
    const body = bodies.get(loan.paperRef);
    if (!body) {
      failed.push({ paperRef: loan.paperRef, rows: loan.rows, issues: loan.issues });
      continue;
    }
    try {
      const recorded = await recordPaperLoan(actor, body, requestId);
      created.push({ paperRef: loan.paperRef, id: recorded.id, customerName: loan.customerName });
    } catch (err) {
      failed.push({
        paperRef: loan.paperRef,
        rows: loan.rows,
        issues: [err instanceof AppError ? err.message : 'Could not be recorded'],
      });
    }
  }

  if (created.length > 0) {
    emitAdminEvent('loan.imported', {
      created: created.length,
      failed: failed.length,
      by: actor.sub,
    });
  }
  return {
    created,
    failed,
    counts: { total: preview.loans.length, created: created.length, failed: failed.length },
  };
}

/** The blank sheet the office starts from: headings, then example rows. */
export function templateRows(): Record<string, string>[] {
  const [example] = layout.templateRows();
  if (!example) return [];
  // A second row shows how another payment on the same loan is written.
  const next: Record<string, string> = Object.fromEntries(Object.keys(example).map((k) => [k, '']));
  const key = (field: ImportField): string =>
    Object.keys(example).find((k) => k.replace(' *', '') === LABEL[field]) ?? LABEL[field];
  next[key('paperRef')] = 'P-0001';
  next[key('paidOn')] = '15/05/2026';
  next[key('amountPaid')] = '600';
  return [example, next];
}
