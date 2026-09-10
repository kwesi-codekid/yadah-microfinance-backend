import ExcelJS from 'exceljs';
import { AppError } from '../../lib/errors.js';
import { parseCsv } from '../../lib/csv-parse.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import { CustomerModel, UserModel } from '../../models/index.js';
import { normalizeGhanaPhone } from '../../schemas/common.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { createCustomer } from './customers.service.js';
import { importedCustomer, type ImportRowInput } from './customers.schemas.js';

/**
 * Bulk registration from a spreadsheet.
 *
 * The office arrives with a book of customers already written down; typing
 * them in one form at a time is the slow part. This reads a CSV or XLSX,
 * checks every row against the same rules a single registration goes through,
 * and hands the findings back so someone can fix what is wrong before any
 * record is written. Nothing is created by the preview.
 *
 * One rule the sheet cannot satisfy: a customer photo. `POST /customers`
 * insists on one, and no column can carry an uploaded image. Imported
 * customers therefore arrive without a photo, to be added at the counter the
 * next time the customer is in — the same way the ID scans are handled.
 */

/** Every column the sheet may carry, in the order the template lays them out. */
export const IMPORT_FIELDS = [
  'fullName',
  'phone',
  'collector',
  'dateOfBirth',
  'gender',
  'maritalStatus',
  'nationality',
  'occupation',
  'residentialAddress',
  'altPhone',
  'idType',
  'idNumber',
  'kinFullName',
  'kinRelationship',
  'kinPhone',
  'kinAddress',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];

export interface ImportColumn {
  field: ImportField;
  /** What the template prints, and what a header is matched against first. */
  header: string;
  required?: boolean;
  /** Other headings people actually use for the same thing. */
  aliases?: readonly string[];
  /** Shown in the template's example row. */
  example: string;
}

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  { field: 'fullName', header: 'Full name', required: true, example: 'AMA MENSAH' },
  {
    field: 'phone',
    header: 'Phone',
    required: true,
    aliases: ['mobile', 'phone number', 'primary phone'],
    example: '0241234567',
  },
  {
    field: 'collector',
    header: 'Collector',
    required: true,
    aliases: ['assigned collector', 'agent', 'round'],
    example: 'Kofi Owusu',
  },
  { field: 'dateOfBirth', header: 'Date of birth', aliases: ['dob'], example: '1990-04-12' },
  { field: 'gender', header: 'Gender', example: 'female' },
  { field: 'maritalStatus', header: 'Marital status', example: 'married' },
  { field: 'nationality', header: 'Nationality', example: 'GHANAIAN' },
  { field: 'occupation', header: 'Occupation', aliases: ['job'], example: 'TRADER' },
  {
    field: 'residentialAddress',
    header: 'Residential address',
    aliases: ['address', 'house address'],
    example: 'ESIAMA MAIN MARKET',
  },
  {
    field: 'altPhone',
    header: 'Secondary phone',
    aliases: ['alt phone', 'alternate phone', 'other phone'],
    example: '0551234567',
  },
  { field: 'idType', header: 'ID type', example: 'ghana-card' },
  { field: 'idNumber', header: 'ID number', example: 'GHA-123456789-0' },
  {
    field: 'kinFullName',
    header: 'Next of kin name',
    aliases: ['next of kin', 'kin name'],
    example: 'KOFI MENSAH',
  },
  { field: 'kinRelationship', header: 'Next of kin relationship', example: 'SPOUSE' },
  { field: 'kinPhone', header: 'Next of kin phone', example: '0209876543' },
  { field: 'kinAddress', header: 'Next of kin address', example: 'ESIAMA' },
];

/** One sheet at a time, and a size the office can still review by eye. */
export const MAX_IMPORT_ROWS = 1_000;

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/plain']);

// ---------------------------------------------------------------- reading the file

/** A spreadsheet cell as text. ExcelJS hands back richer shapes than strings. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return toIsoDay(value);
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text.trim();
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText
        .map((r) => r.text)
        .join('')
        .trim();
    }
    if ('result' in value) return cellText(value.result);
  }
  return '';
}

function toIsoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Headers match on letters and digits only, so spacing and case never matter. */
function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

const HEADER_LOOKUP = new Map<string, ImportField>();
for (const column of IMPORT_COLUMNS) {
  HEADER_LOOKUP.set(normalizeHeader(column.header), column.field);
  HEADER_LOOKUP.set(normalizeHeader(column.field), column.field);
  for (const alias of column.aliases ?? []) HEADER_LOOKUP.set(normalizeHeader(alias), column.field);
}

async function readGrid(file: { buffer: Buffer; mimetype: string; originalname: string }) {
  const isCsv = CSV_TYPES.has(file.mimetype) || file.originalname.toLowerCase().endsWith('.csv');
  if (isCsv) return parseCsv(file.buffer.toString('utf8'));

  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(file.buffer as unknown as ArrayBuffer);
  } catch {
    throw new AppError(
      'UNREADABLE_FILE',
      'That file could not be read as a spreadsheet — save it as .xlsx or .csv and try again',
      422,
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new AppError('UNREADABLE_FILE', 'The workbook has no sheets', 422);

  const grid: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    const cells: string[] = [];
    // `values` is 1-based with a hole at index 0.
    const values = row.values as ExcelJS.CellValue[];
    for (let c = 1; c < values.length; c++) cells.push(cellText(values[c] ?? null));
    if (cells.some((v) => v !== '')) grid.push(cells);
  });
  return grid;
}

export interface ParsedSheet {
  /** Sheet row number each entry came from, for messages that name a row. */
  rows: { row: number; values: Record<ImportField, string> }[];
  /** Headings the sheet carried that matched nothing — usually a typo. */
  unknownHeaders: string[];
}

/** Turn the grid into field-keyed rows, using the header line to place columns. */
export function mapGrid(grid: string[][]): ParsedSheet {
  const header = grid[0];
  if (!header) throw new AppError('EMPTY_FILE', 'That file has no rows', 422);

  const placements = new Map<number, ImportField>();
  const unknownHeaders: string[] = [];
  header.forEach((cell, index) => {
    const text = cell.trim();
    if (text === '') return;
    const field = HEADER_LOOKUP.get(normalizeHeader(text));
    if (field) placements.set(index, field);
    else unknownHeaders.push(text);
  });

  if (placements.size === 0) {
    throw new AppError(
      'NO_KNOWN_COLUMNS',
      'None of the headings on the first row match the template — download it and start from there',
      422,
    );
  }

  const body = grid.slice(1);
  if (body.length > MAX_IMPORT_ROWS) {
    throw new AppError(
      'TOO_MANY_ROWS',
      `That sheet has ${String(body.length)} rows; ${String(MAX_IMPORT_ROWS)} is the most one import may carry`,
      422,
      { rows: body.length, max: MAX_IMPORT_ROWS },
    );
  }

  const rows = body.map((cells, i) => {
    const values = blankRow();
    for (const [index, field] of placements) values[field] = (cells[index] ?? '').trim();
    // +2: one for the header line, one because sheets count from 1.
    return { row: i + 2, values };
  });
  return { rows, unknownHeaders };
}

export function blankRow(): Record<ImportField, string> {
  return Object.fromEntries(IMPORT_FIELDS.map((f) => [f, ''])) as Record<ImportField, string>;
}

// ---------------------------------------------------------------- normalising cells

/** Free text the branch records in capitals, as the registration form does. */
function caps(value: string): string | undefined {
  const v = value.trim();
  return v === '' ? undefined : v.toUpperCase();
}

function plain(value: string): string | undefined {
  const v = value.trim();
  return v === '' ? undefined : v;
}

/** `12/04/1990` and `12-04-1990` are how people write dates here. */
function normalizeDay(value: string): string | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(v);
  if (dmy) {
    const [, d, m, y] = dmy as unknown as [string, string, string, string];
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  return v; // handed on as-is so the schema is the one that refuses it
}

/** Enum cells, matched on letters only: "Ghana Card" and "ghana_card" agree. */
function matchEnum(value: string, allowed: readonly string[]): string | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  const key = v.toLowerCase().replace(/[^a-z]/g, '');
  const hit = allowed.find((a) => a.toLowerCase().replace(/[^a-z]/g, '') === key);
  return hit ?? v; // unmatched text is handed on so the schema names the field
}

const GENDERS = ['male', 'female'] as const;
const MARITAL_STATUSES = ['single', 'married', 'other'] as const;
const ID_TYPES = ['ghana-card', 'passport', 'drivers-license', 'voter-id'] as const;

// ---------------------------------------------------------------- validation

export interface RowIssue {
  /** The column to point at, or null for something about the row as a whole. */
  field: ImportField | null;
  message: string;
}

export interface PreviewRow {
  row: number;
  values: Record<ImportField, string>;
  /** Resolved from the collector cell; empty when it matched nothing. */
  assignedCollectorId: string;
  issues: RowIssue[];
}

export interface ImportPreview {
  rows: PreviewRow[];
  unknownHeaders: string[];
  /** Every collector a row may be put on, for the preview's picker. */
  collectors: { id: string; name: string }[];
  counts: { total: number; ready: number; blocked: number };
}

/** Which column a Zod issue belongs to, so the preview can flag one cell. */
function fieldForPath(path: readonly PropertyKey[]): ImportField | null {
  const [head, next] = path.map(String);
  if (head === 'identification') return next === 'idType' ? 'idType' : 'idNumber';
  if (head === 'nextOfKin') {
    if (next === 'fullName') return 'kinFullName';
    if (next === 'relationship') return 'kinRelationship';
    if (next === 'phone') return 'kinPhone';
    return 'kinAddress';
  }
  if (head === 'assignedCollectorId') return 'collector';
  return IMPORT_FIELDS.includes(head as ImportField) ? (head as ImportField) : null;
}

/** The object the schema sees, built from the row's cells. */
function toCandidate(values: Record<ImportField, string>, collectorId: string) {
  const idType = matchEnum(values.idType, ID_TYPES);
  const idNumber = caps(values.idNumber);
  const kinName = caps(values.kinFullName);
  const kinRest = [values.kinRelationship, values.kinPhone, values.kinAddress].some(
    (v) => v.trim() !== '',
  );

  return {
    fullName: caps(values.fullName) ?? '',
    phone: plain(values.phone) ?? '',
    assignedCollectorId: collectorId,
    dateOfBirth: normalizeDay(values.dateOfBirth),
    gender: matchEnum(values.gender, GENDERS),
    maritalStatus: matchEnum(values.maritalStatus, MARITAL_STATUSES),
    nationality: caps(values.nationality),
    occupation: caps(values.occupation),
    residentialAddress: caps(values.residentialAddress),
    altPhone: plain(values.altPhone),
    // Both halves or neither: the API stores the block whole.
    ...(idType !== undefined || idNumber !== undefined
      ? { identification: { idType, idNumber } }
      : {}),
    ...(kinName !== undefined || kinRest
      ? {
          nextOfKin: {
            fullName: kinName,
            relationship: caps(values.kinRelationship),
            phone: plain(values.kinPhone),
            address: caps(values.kinAddress),
          },
        }
      : {}),
  };
}

/** Active collectors, by id and by the names a sheet is likely to use. */
async function collectorIndex(): Promise<{
  list: { id: string; name: string }[];
  byName: Map<string, string>;
}> {
  const users = await UserModel.find(
    { role: 'collector', status: 'active' },
    { name: 1, username: 1 },
  ).sort({ name: 1 });

  const byName = new Map<string, string>();
  const list = users.map((u) => {
    const id = u._id.toHexString();
    byName.set(normalizeHeader(u.name), id);
    byName.set(normalizeHeader(u.username), id);
    byName.set(id, id);
    return { id, name: u.name };
  });
  return { list, byName };
}

/**
 * Check every row without writing anything. Format, enum and required-field
 * faults come from the same schema a single registration uses; the rest are
 * the checks only the whole file and the database can answer — a phone that
 * repeats inside the sheet, or one already on another customer.
 */
export async function validateRows(
  rows: { row: number; values: Record<ImportField, string> }[],
  unknownHeaders: string[] = [],
): Promise<ImportPreview> {
  const { list, byName } = await collectorIndex();

  // Phones and ID numbers already on the books. One query each, rather than
  // one per row: a thousand-row sheet should not be a thousand round trips.
  const phones = new Set<string>();
  const idNumbers = new Set<string>();
  for (const { values } of rows) {
    if (values.phone.trim()) phones.add(normalizeGhanaPhone(values.phone));
    if (values.idNumber.trim()) idNumbers.add(values.idNumber.trim().toUpperCase());
  }
  const [takenPhones, takenIds] = await Promise.all([
    phones.size
      ? CustomerModel.find({ phone: { $in: [...phones] } }, { phone: 1 }).lean()
      : Promise.resolve([]),
    idNumbers.size
      ? CustomerModel.find(
          { 'identification.idNumber': { $in: [...idNumbers] } },
          { identification: 1 },
        ).lean()
      : Promise.resolve([]),
  ]);
  const phoneTaken = new Set(takenPhones.map((c) => c.phone));
  const idTaken = new Set(takenIds.map((c) => c.identification?.idNumber).filter(Boolean));

  // Seen inside this sheet, so the second row carrying a number is the one flagged.
  const seenPhone = new Map<string, number>();
  const seenId = new Map<string, number>();

  const out: PreviewRow[] = rows.map(({ row, values }) => {
    const issues: RowIssue[] = [];

    const collectorCell = values.collector.trim();
    const collectorId = collectorCell ? (byName.get(normalizeHeader(collectorCell)) ?? '') : '';
    if (collectorCell && !collectorId) {
      issues.push({
        field: 'collector',
        message: `No active collector called "${collectorCell}"`,
      });
    }

    const parsed = importedCustomer.safeParse(toCandidate(values, collectorId));
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = fieldForPath(issue.path);
        // The collector is already named above in its own words.
        if (field === 'collector' && issues.some((i) => i.field === 'collector')) continue;
        issues.push({
          field,
          message:
            field === 'collector'
              ? 'Choose the collector whose round this customer joins'
              : issue.message,
        });
      }
    }

    if (values.phone.trim()) {
      const phone = normalizeGhanaPhone(values.phone);
      const earlier = seenPhone.get(phone);
      if (earlier !== undefined) {
        issues.push({ field: 'phone', message: `Same phone as row ${String(earlier)}` });
      } else {
        seenPhone.set(phone, row);
        if (phoneTaken.has(phone)) {
          issues.push({ field: 'phone', message: 'A customer already has this phone number' });
        }
      }
    }

    if (values.idNumber.trim()) {
      const id = values.idNumber.trim().toUpperCase();
      const earlier = seenId.get(id);
      if (earlier !== undefined) {
        issues.push({ field: 'idNumber', message: `Same ID number as row ${String(earlier)}` });
      } else {
        seenId.set(id, row);
        if (idTaken.has(id)) {
          issues.push({ field: 'idNumber', message: 'A customer already has this ID number' });
        }
      }
    }

    return { row, values, assignedCollectorId: collectorId, issues };
  });

  const blocked = out.filter((r) => r.issues.length > 0).length;
  return {
    rows: out,
    unknownHeaders,
    collectors: list,
    counts: { total: out.length, ready: out.length - blocked, blocked },
  };
}

/** Read an uploaded sheet and check it. Writes nothing. */
export async function previewImportFile(file: {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}): Promise<ImportPreview> {
  const grid = await readGrid(file);
  const { rows, unknownHeaders } = mapGrid(grid);
  return validateRows(rows, unknownHeaders);
}

// ---------------------------------------------------------------- writing

export interface ImportOutcome {
  created: { row: number; id: string; fullName: string }[];
  failed: { row: number; issues: RowIssue[] }[];
  counts: { total: number; created: number; failed: number };
}

/**
 * Register the rows the office accepted.
 *
 * Row by row rather than all-or-nothing: a sheet of two hundred should not be
 * thrown away because one phone number was taken while the preview was open.
 * What failed comes back with its reason, ready to be corrected and sent
 * again — the rows that succeeded are simply gone from the retry.
 */
export async function importCustomers(
  actor: AccessTokenPayload,
  rows: ImportRowInput[],
  requestId?: string,
): Promise<ImportOutcome> {
  if (rows.length === 0) throw new AppError('EMPTY_IMPORT', 'No rows were sent', 422);
  if (rows.length > MAX_IMPORT_ROWS) {
    throw new AppError(
      'TOO_MANY_ROWS',
      `${String(MAX_IMPORT_ROWS)} rows is the most one import may carry`,
      422,
    );
  }

  // The preview may have been open for a while; everything is checked again.
  const checked = await validateRows(
    rows.map((r, i) => ({ row: r.row ?? i + 2, values: { ...blankRow(), ...r.values } })),
  );

  const created: ImportOutcome['created'] = [];
  const failed: ImportOutcome['failed'] = [];

  for (const row of checked.rows) {
    if (row.issues.length > 0) {
      failed.push({ row: row.row, issues: row.issues });
      continue;
    }
    const parsed = importedCustomer.safeParse(toCandidate(row.values, row.assignedCollectorId));
    if (!parsed.success) {
      failed.push({
        row: row.row,
        issues: parsed.error.issues.map((i) => ({
          field: fieldForPath(i.path),
          message: i.message,
        })),
      });
      continue;
    }
    try {
      const customer = await createCustomer(actor, parsed.data, requestId, { silent: true });
      created.push({ row: row.row, id: customer.id, fullName: customer.fullName });
    } catch (err) {
      failed.push({
        row: row.row,
        issues: [
          {
            field: err instanceof AppError && err.code === 'PHONE_TAKEN' ? 'phone' : null,
            message: err instanceof AppError ? err.message : 'Could not be registered',
          },
        ],
      });
    }
  }

  // One event for the batch. Emitting per customer would have every dashboard
  // refetch a hundred times over a single import.
  if (created.length > 0) {
    emitAdminEvent('customer.imported', {
      created: created.length,
      failed: failed.length,
      by: actor.sub,
    });
  }

  return {
    created,
    failed,
    counts: { total: checked.rows.length, created: created.length, failed: failed.length },
  };
}

/** The blank sheet the office starts from: headings, then one example row. */
export function templateRows(): Record<string, string>[] {
  const example: Record<string, string> = {};
  for (const column of IMPORT_COLUMNS) {
    example[column.required ? `${column.header} *` : column.header] = column.example;
  }
  return [example];
}
