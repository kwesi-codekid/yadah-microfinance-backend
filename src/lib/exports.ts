import type { Response } from 'express';
import { toCsv } from './csv.js';
import { toXlsxBuffer } from './excel.js';

export type ExportFormat = 'json' | 'csv' | 'xlsx';

export interface ExportArgs {
  format: ExportFormat;
  /** Download filename without extension. */
  filename: string;
  /** Body for format=json. */
  payload: unknown;
  /** Flat rows for csv/xlsx. */
  rows: readonly object[];
  /** Row keys holding integer pesewas — rendered as GHS decimals in xlsx only. */
  moneyKeys?: readonly string[];
  sheet?: string;
}

/** Listing exports skip pagination but are capped — documented in OpenAPI. */
export const EXPORT_MAX_ROWS = 10_000;

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/** One response helper for every endpoint offering json/csv/xlsx downloads. */
export async function sendExport(res: Response, args: ExportArgs): Promise<void> {
  if (args.format === 'csv') {
    res.type('text/csv').attachment(`${args.filename}.csv`).send(toCsv(args.rows));
    return;
  }
  if (args.format === 'xlsx') {
    const buffer = await toXlsxBuffer(args.rows, {
      ...(args.sheet !== undefined ? { sheet: args.sheet } : {}),
      ...(args.moneyKeys !== undefined ? { moneyKeys: args.moneyKeys } : {}),
    });
    res.type(XLSX_MIME).attachment(`${args.filename}.xlsx`).send(buffer);
    return;
  }
  res.json(args.payload);
}
