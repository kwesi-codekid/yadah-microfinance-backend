import { AppError } from '../../lib/errors.js';
import { emitAdminEvent } from '../../lib/realtime.js';
import {
  MAX_IMPORT_ROWS,
  SheetLayout,
  cedisToPesewas,
  matchEnum,
  normalizeHeader,
  plain,
  readSheet,
  wholeNumber,
  type SheetColumn,
  type SheetFile,
} from '../../lib/sheet-import.js';
import { HpItemModel, labelKey } from '../../models/index.js';
import { NOT_TRASHED } from '../../models/shared.js';
import type { AccessTokenPayload } from '../auth/auth.service.js';
import { labelIndex } from './hp-labels.service.js';
import { createItem } from './hp.service.js';
import { createItemBody, type ImportItemRowInput } from './hp.schemas.js';

/**
 * Stocking the shelf from a spreadsheet.
 *
 * A supplier's delivery note or the branch's own stock list already has the
 * items written down; typing each one into the drawer is the slow part. This
 * reads a CSV or XLSX, holds every row to the rules one item goes through, and
 * hands the findings back so the counter can fix what is wrong before any
 * item is written. Nothing is created by the preview.
 *
 * Prices on the sheet are in cedis, because that is how people write them.
 * They are turned into pesewas here, at the door, and never later. Brand and
 * category cells name managed labels; a name nobody has added yet is flagged
 * rather than invented, which is the whole point of managing them.
 */

export const IMPORT_FIELDS = [
  'name',
  'brand',
  'category',
  'description',
  'condition',
  'quantityInStock',
  'costPrice',
  'sellingPrice',
] as const;

export type ImportField = (typeof IMPORT_FIELDS)[number];
export type ImportColumn = SheetColumn<ImportField>;

export const IMPORT_COLUMNS: readonly ImportColumn[] = [
  {
    field: 'name',
    header: 'Item',
    required: true,
    aliases: ['item name', 'name', 'product', 'product name'],
    example: 'Double-door fridge 350L',
  },
  { field: 'brand', header: 'Brand', aliases: ['make', 'manufacturer'], example: 'Nasco' },
  { field: 'category', header: 'Category', aliases: ['type', 'kind'], example: 'Fridge' },
  {
    field: 'description',
    header: 'Description',
    aliases: ['model', 'details', 'notes'],
    example: 'Silver, model NF-350',
  },
  { field: 'condition', header: 'Condition', aliases: ['state'], example: 'new' },
  {
    field: 'quantityInStock',
    header: 'Quantity',
    required: true,
    aliases: ['qty', 'stock', 'units', 'in stock', 'quantity in stock'],
    example: '4',
  },
  {
    field: 'costPrice',
    header: 'Cost price',
    required: true,
    aliases: ['cost', 'purchase price', 'buying price', 'cost price ghs'],
    example: '2800',
  },
  {
    field: 'sellingPrice',
    header: 'Selling price',
    required: true,
    aliases: ['price', 'retail price', 'selling price ghs'],
    example: '3500',
  },
];

export { MAX_IMPORT_ROWS };

const layout = new SheetLayout(IMPORT_COLUMNS);

export function blankRow(): Record<ImportField, string> {
  return layout.blankRow();
}

const CONDITIONS = ['new', 'used'] as const;

// ---------------------------------------------------------------- validation

export interface RowIssue {
  /** The column to point at, or null for something about the row as a whole. */
  field: ImportField | null;
  message: string;
}

export interface PreviewRow {
  row: number;
  values: Record<ImportField, string>;
  /** Resolved from the brand cell; empty when it matched nothing. */
  brandId: string;
  /** Resolved from the category cell; empty when it matched nothing. */
  categoryId: string;
  issues: RowIssue[];
}

export interface ImportPreview {
  rows: PreviewRow[];
  unknownHeaders: string[];
  /** Every brand and category a row may be filed under, for the preview's pickers. */
  brands: { id: string; name: string }[];
  categories: { id: string; name: string }[];
  counts: { total: number; ready: number; blocked: number };
}

/** How two rows, or a row and the shelf, are judged to be the same item. */
function itemKey(name: string, brandId: string): string {
  return `${brandId}|${normalizeHeader(name)}`;
}

/**
 * The object the schema sees, plus the two faults the schema would only
 * report as "expected number": a price or a quantity that is not one.
 */
function toCandidate(
  values: Record<ImportField, string>,
  brandId: string,
  categoryId: string,
): {
  candidate: Record<string, unknown>;
  issues: RowIssue[];
} {
  const issues: RowIssue[] = [];

  const quantity = wholeNumber(values.quantityInStock);
  if (Number.isNaN(quantity)) {
    issues.push({ field: 'quantityInStock', message: 'A whole number of units, like 4' });
  }
  const costPrice = cedisToPesewas(values.costPrice);
  if (Number.isNaN(costPrice)) {
    issues.push({ field: 'costPrice', message: 'An amount in cedis, like 2800 or 2,800.50' });
  }
  const sellingPrice = cedisToPesewas(values.sellingPrice);
  if (Number.isNaN(sellingPrice)) {
    issues.push({ field: 'sellingPrice', message: 'An amount in cedis, like 3500 or 3,500.00' });
  } else if (
    sellingPrice !== undefined &&
    costPrice !== undefined &&
    !Number.isNaN(costPrice) &&
    sellingPrice < costPrice
  ) {
    // Named here rather than left to the schema, whose cross-field check does
    // not run while another cell on the row is still wrong.
    issues.push({
      field: 'sellingPrice',
      message: 'Below the cost price — enter the same figure twice to sell at cost',
    });
  }

  const candidate = {
    name: plain(values.name) ?? '',
    brandId: brandId || undefined,
    categoryId: categoryId || undefined,
    description: plain(values.description),
    condition: matchEnum(values.condition, CONDITIONS),
    // Required cells left blank are handed on as undefined so the schema
    // names them; the NaN cases were named above.
    quantityInStock: Number.isNaN(quantity) ? undefined : quantity,
    costPrice: Number.isNaN(costPrice) ? undefined : costPrice,
    sellingPrice: Number.isNaN(sellingPrice) ? undefined : sellingPrice,
  };
  return { candidate, issues };
}

function fieldForPath(path: readonly PropertyKey[]): ImportField | null {
  const head = String(path[0] ?? '');
  return IMPORT_FIELDS.includes(head as ImportField) ? (head as ImportField) : null;
}

/** The schema's message, in the sheet's own words where the schema's are technical. */
function plainMessage(field: ImportField | null, message: string): string {
  if (field === 'quantityInStock' && /expected number/i.test(message)) {
    return 'How many units are on the shelf';
  }
  if ((field === 'costPrice' || field === 'sellingPrice') && /expected number/i.test(message)) {
    return 'An amount in cedis';
  }
  if (field === 'name' && /too small|expected string/i.test(message)) {
    return 'An item needs a name';
  }
  if (field === 'condition') return 'New or used';
  if (field === 'sellingPrice' && /at least costPrice/i.test(message)) {
    return 'Below the cost price — enter the same figure twice to sell at cost';
  }
  return message;
}

/**
 * Check every row without writing anything. Format and required-field faults
 * come from the same schema a single item goes through; the rest is what only
 * the whole file and the shelf can answer — the same item twice in the sheet,
 * or one that is already stocked.
 */
export async function validateRows(
  rows: { row: number; values: Record<ImportField, string> }[],
  unknownHeaders: string[] = [],
): Promise<ImportPreview> {
  // The shelf is a few hundred lines at most; one read covers every row.
  const [shelf, brands, categories] = await Promise.all([
    HpItemModel.find(NOT_TRASHED, { name: 1, brandId: 1 }).lean(),
    labelIndex('brand'),
    labelIndex('category'),
  ]);
  const stocked = new Set(shelf.map((i) => itemKey(i.name, i.brandId?.toHexString() ?? '')));
  const seen = new Map<string, number>();

  const out: PreviewRow[] = rows.map(({ row, values }) => {
    const issues: RowIssue[] = [];

    // A label cell names one of the managed labels, or it names nothing and
    // the row is filed under none. A name nobody has added is the fault.
    const brandCell = values.brand.trim();
    const brandId = brandCell ? (brands.byKey.get(labelKey(brandCell)) ?? '') : '';
    if (brandCell && !brandId) {
      issues.push({
        field: 'brand',
        message: `No brand called "${brandCell}" — add it, or pick one`,
      });
    }
    const categoryCell = values.category.trim();
    const categoryId = categoryCell ? (categories.byKey.get(labelKey(categoryCell)) ?? '') : '';
    if (categoryCell && !categoryId) {
      issues.push({
        field: 'category',
        message: `No category called "${categoryCell}" — add it, or pick one`,
      });
    }

    const { candidate, issues: own } = toCandidate(values, brandId, categoryId);
    issues.push(...own);
    const flagged = new Set(issues.map((i) => i.field));

    const parsed = createItemBody.safeParse(candidate);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = fieldForPath(issue.path);
        if (field !== null && flagged.has(field)) continue;
        flagged.add(field);
        issues.push({ field, message: plainMessage(field, issue.message) });
      }
    }

    if (values.name.trim()) {
      const key = itemKey(values.name, brandId);
      const earlier = seen.get(key);
      if (earlier !== undefined) {
        issues.push({ field: 'name', message: `Same item as row ${String(earlier)}` });
      } else {
        seen.set(key, row);
        if (stocked.has(key)) {
          issues.push({
            field: 'name',
            message: 'Already on the shelf — adjust its stock instead of adding it again',
          });
        }
      }
    }

    return { row, values, brandId, categoryId, issues };
  });

  const blocked = out.filter((r) => r.issues.length > 0).length;
  return {
    rows: out,
    unknownHeaders,
    brands: brands.list,
    categories: categories.list,
    counts: { total: out.length, ready: out.length - blocked, blocked },
  };
}

/** Read an uploaded sheet and check it. Writes nothing. */
export async function previewImportFile(file: SheetFile): Promise<ImportPreview> {
  const { rows, unknownHeaders } = await readSheet(file, layout);
  return validateRows(rows, unknownHeaders);
}

// ---------------------------------------------------------------- writing

export interface ImportOutcome {
  created: { row: number; id: string; name: string }[];
  failed: { row: number; issues: RowIssue[] }[];
  counts: { total: number; created: number; failed: number };
}

/**
 * Put the accepted rows on the shelf.
 *
 * Row by row rather than all-or-nothing: a delivery of forty lines should not
 * be thrown away because one price was typed wrong. What failed comes back
 * with its reason, ready to be corrected and sent again; the rows that went
 * in are simply gone from the retry.
 */
export async function importItems(
  actor: AccessTokenPayload,
  rows: ImportItemRowInput[],
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

  // The preview may have sat open while somebody stocked the same thing by
  // hand; everything is checked again.
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
    const parsed = createItemBody.safeParse(
      toCandidate(row.values, row.brandId, row.categoryId).candidate,
    );
    if (!parsed.success) {
      failed.push({
        row: row.row,
        issues: parsed.error.issues.map((i) => {
          const field = fieldForPath(i.path);
          return { field, message: plainMessage(field, i.message) };
        }),
      });
      continue;
    }
    try {
      const item = await createItem(actor, parsed.data, requestId);
      created.push({ row: row.row, id: item.id, name: item.name });
    } catch (err) {
      failed.push({
        row: row.row,
        issues: [
          {
            field: null,
            message: err instanceof AppError ? err.message : 'Could not be added',
          },
        ],
      });
    }
  }

  // One event for the batch, not one per item.
  if (created.length > 0) {
    emitAdminEvent('hp.item.imported', {
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

/** The blank sheet to start from: headings, then one example row. */
export function templateRows(): Record<string, string>[] {
  return layout.templateRows();
}
