/**
 * Minimal CSV reader — the mirror of `toCsv`, for spreadsheets coming the
 * other way. Handles quoted cells, embedded commas and newlines, doubled
 * quotes, and both CRLF and LF endings.
 *
 * Every cell comes back as a string: what a cell means is the importer's
 * business, not the reader's. Blank lines are dropped, because a sheet saved
 * out of Excel usually ends with a few.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  // Excel's "Save as CSV" writes a byte-order mark, which would otherwise
  // become part of the first header and stop it matching a column.
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const endCell = (): void => {
    row.push(cell);
    cell = '';
  };
  const endRow = (): void => {
    endCell();
    rows.push(row);
    row = [];
  };

  for (; i < text.length; i++) {
    const c = text.charAt(i);

    if (quoted) {
      if (c !== '"') {
        cell += c;
      } else if (text.charAt(i + 1) === '"') {
        cell += '"';
        i++;
      } else {
        quoted = false;
      }
      continue;
    }

    if (c === '"') {
      quoted = true;
    } else if (c === ',') {
      endCell();
    } else if (c === '\n') {
      endRow();
    } else if (c === '\r') {
      if (text.charAt(i + 1) === '\n') i++;
      endRow();
    } else {
      cell += c;
    }
  }
  if (cell !== '' || row.length > 0) endRow();

  return rows.filter((r) => r.some((v) => v.trim() !== ''));
}
