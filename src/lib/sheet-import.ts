import ExcelJS from 'exceljs';
import { AppError } from './errors.js';
import { parseCsv } from './csv-parse.js';

/**
 * Reading an uploaded spreadsheet into rows keyed by column, for any importer.
 *
 * What differs between importers is the columns and what a cell means. What
 * does not differ is everything before that: opening a .csv or .xlsx, turning
 * cells into text, matching the sheet's headings to the columns we know, and
 * numbering the rows the way the sheet does so a message can name a line.
 * That half lives here; each importer supplies its columns and takes the
 * field-keyed rows.
 */

/** One sheet at a time, and a size a person can still review by eye. */
export const MAX_IMPORT_ROWS = 1_000;

export interface SheetFile {
  buffer: Buffer;
  mimetype: string;
  originalname: string;
}

export interface SheetColumn<F extends string> {
  field: F;
  /** What the template prints, and what a heading is matched against first. */
  header: string;
  required?: boolean;
  /** Other headings people actually use for the same thing. */
  aliases?: readonly string[];
  /** Shown in the template's example row. */
  example: string;
}

const CSV_TYPES = new Set(['text/csv', 'application/csv', 'text/plain']);

// ---------------------------------------------------------------- the grid

/** A spreadsheet cell as text. ExcelJS hands back richer shapes than strings. */
function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
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

/** The file as rows of text cells, blank rows dropped. */
export async function readGrid(file: SheetFile): Promise<string[][]> {
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

// ---------------------------------------------------------------- headings

/** Headings match on letters and digits only, so spacing and case never matter. */
export function normalizeHeader(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export interface ParsedSheet<F extends string> {
  /** Sheet row number each entry came from, for messages that name a row. */
  rows: { row: number; values: Record<F, string> }[];
  /** Headings the sheet carried that matched nothing — usually a typo. */
  unknownHeaders: string[];
}

/**
 * The columns an importer reads, with the lookup that places a heading.
 * Built once per importer; `mapGrid` and `blankRow` are then the whole job.
 */
export class SheetLayout<F extends string> {
  private readonly lookup = new Map<string, F>();
  readonly fields: readonly F[];

  constructor(readonly columns: readonly SheetColumn<F>[]) {
    this.fields = columns.map((c) => c.field);
    for (const column of columns) {
      this.lookup.set(normalizeHeader(column.header), column.field);
      this.lookup.set(normalizeHeader(column.field), column.field);
      for (const alias of column.aliases ?? []) {
        this.lookup.set(normalizeHeader(alias), column.field);
      }
    }
  }

  blankRow(): Record<F, string> {
    return Object.fromEntries(this.fields.map((f) => [f, ''])) as Record<F, string>;
  }

  /** Turn the grid into field-keyed rows, using the header line to place columns. */
  mapGrid(grid: string[][]): ParsedSheet<F> {
    const header = grid[0];
    if (!header) throw new AppError('EMPTY_FILE', 'That file has no rows', 422);

    const placements = new Map<number, F>();
    const unknownHeaders: string[] = [];
    header.forEach((cell, index) => {
      const text = cell.trim();
      if (text === '') return;
      const field = this.lookup.get(normalizeHeader(text));
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
      const values = this.blankRow();
      for (const [index, field] of placements) values[field] = (cells[index] ?? '').trim();
      // +2: one for the header line, one because sheets count from 1.
      return { row: i + 2, values };
    });
    return { rows, unknownHeaders };
  }

  /** The blank sheet people start from: headings, then one example row. */
  templateRows(): Record<string, string>[] {
    const example: Record<string, string> = {};
    for (const column of this.columns) {
      example[column.required ? `${column.header} *` : column.header] = column.example;
    }
    return [example];
  }
}

/** Read an uploaded sheet and place its columns. Writes nothing. */
export async function readSheet<F extends string>(
  file: SheetFile,
  layout: SheetLayout<F>,
): Promise<ParsedSheet<F>> {
  return layout.mapGrid(await readGrid(file));
}

// ---------------------------------------------------------------- cells

/** Free text the branch records in capitals, as its paper forms do. */
export function caps(value: string): string | undefined {
  const v = value.trim();
  return v === '' ? undefined : v.toUpperCase();
}

export function plain(value: string): string | undefined {
  const v = value.trim();
  return v === '' ? undefined : v;
}

/**
 * Enum cells, matched on letters only: "Ghana Card" and "ghana_card" agree.
 * Unmatched text is handed on as-is so the schema is the one that names the
 * field, rather than the importer silently dropping what somebody typed.
 */
export function matchEnum(value: string, allowed: readonly string[]): string | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  const key = v.toLowerCase().replace(/[^a-z]/g, '');
  const hit = allowed.find((a) => a.toLowerCase().replace(/[^a-z]/g, '') === key);
  return hit ?? v;
}

/**
 * A money cell in cedis — "1,200", "1200.50", "GH₵ 1,200" — as integer
 * pesewas. Anything that is not a number comes back as NaN so the schema can
 * refuse it by name; an empty cell is undefined, which optional fields allow.
 */
export function cedisToPesewas(value: string): number | undefined {
  const v = value.trim();
  if (v === '') return undefined;
  const cleaned = v.replace(/^(?:gh[sc₵]|ghs|₵)\s*/i, '').replace(/,/g, '');
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(cleaned)) return Number.NaN;
  return Math.round(Number(cleaned) * 100);
}

/** A whole-number cell. NaN for anything else, so the schema names it. */
export function wholeNumber(value: string): number | undefined {
  const v = value.trim().replace(/,/g, '');
  if (v === '') return undefined;
  return /^-?\d+$/.test(v) ? Number(v) : Number.NaN;
}
