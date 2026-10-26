import { cutDelimitedRow, type DelimitedTable } from './delimitedText';

/** Zero-based parsed coordinates. Row 0 is the displayed header. */
export type TablePoint = { row: number; column: number };
export type TableSelection = { anchor: TablePoint; focus: TablePoint };

export const selectionBounds = ({ anchor, focus }: TableSelection) => ({
  firstRow: Math.min(anchor.row, focus.row),
  lastRow: Math.max(anchor.row, focus.row),
  firstColumn: Math.min(anchor.column, focus.column),
  lastColumn: Math.max(anchor.column, focus.column),
});

/** Data navigation steps by cells or jumps to the corresponding table edge. */
export const navigateTableSelection = (
  selection: TableSelection | null,
  key: string,
  extend: boolean,
  edge: boolean,
  bodyRows: number,
  columns: number,
  rtl: boolean,
): TableSelection | null => {
  if (columns === 0) return null;
  const current = selection?.focus ?? { row: 0, column: 0 };
  let { row, column } = current;
  switch (key) {
    case 'ArrowUp': row = edge ? 0 : row - 1; break;
    case 'ArrowDown': row = edge ? bodyRows : row + 1; break;
    case 'ArrowLeft': column = edge ? (rtl ? columns - 1 : 0) : column + (rtl ? 1 : -1); break;
    case 'ArrowRight': column = edge ? (rtl ? 0 : columns - 1) : column + (rtl ? -1 : 1); break;
    case 'Home': column = 0; if (edge) row = 0; break;
    case 'End': column = columns - 1; if (edge) row = bodyRows; break;
    default: return null;
  }
  const focus = {
    row: Math.max(0, Math.min(bodyRows, row)),
    column: Math.max(0, Math.min(columns - 1, column)),
  };
  return { anchor: extend ? (selection?.anchor ?? current) : focus, focus };
};

const tsvField = (value: string): string => (
  /[\t\r\n"]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
);
const htmlText = (value: string): string => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#39;');

/**
 * Copy reads original parsed spans one row at a time. It never fills the
 * viewport cache or constructs a second table DOM. Decoding scans every field
 * of each selected source row; formatting and output cost the selected fields.
 */
export const serializeTableSelection = (
  content: string,
  delimiter: ',' | '\t',
  table: DelimitedTable,
  selection: TableSelection,
) => {
  const bounds = selectionBounds(selection);
  const lines: string[] = [];
  const html: string[] = ['<table>'];
  for (let row = bounds.firstRow; row <= bounds.lastRow; row += 1) {
    const span = table.rows[row - 1];
    const values = row === 0 ? table.header : span ? cutDelimitedRow(content, span, delimiter) : [];
    const fields: string[] = [];
    const cells: string[] = [];
    for (let column = bounds.firstColumn; column <= bounds.lastColumn; column += 1) {
      const value = values[column] ?? '';
      fields.push(tsvField(value));
      cells.push(row === 0
        ? `<th scope="col">${htmlText(value)}</th>`
        : `<td>${htmlText(value)}</td>`);
    }
    lines.push(fields.join('\t'));
    if (row === 0) html.push(`<thead><tr>${cells.join('')}</tr></thead>`);
    else {
      if (row === Math.max(1, bounds.firstRow)) html.push('<tbody>');
      html.push(`<tr>${cells.join('')}</tr>`);
    }
  }
  if (bounds.lastRow > 0) html.push('</tbody>');
  html.push('</table>');
  return { text: lines.join('\n'), html: html.join('') };
};
