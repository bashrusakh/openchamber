import { describe, expect, test } from 'bun:test';

import { parseDelimitedText } from './delimitedText';
import { navigateTableSelection, selectionBounds, serializeTableSelection } from './tableSelection';

describe('coordinate table selection experiment', () => {
  test('normalizes reverse rectangular bounds without changing anchor and focus', () => {
    const selection = { anchor: { row: 80, column: 20 }, focus: { row: 2, column: 3 } };
    expect(selectionBounds(selection)).toEqual({ firstRow: 2, lastRow: 80, firstColumn: 3, lastColumn: 20 });
    expect(selection.anchor).toEqual({ row: 80, column: 20 });
  });

  test('extends by cells, clamps edges, and keeps the anchor across reverse navigation', () => {
    const selection = { anchor: { row: 3, column: 4 }, focus: { row: 2, column: 1 } };
    expect(navigateTableSelection(selection, 'ArrowLeft', true, false, 2000, 5000, false)).toEqual({
      anchor: selection.anchor, focus: { row: 2, column: 0 },
    });
    expect(navigateTableSelection(selection, 'ArrowDown', true, true, 2000, 5000, false)).toEqual({
      anchor: selection.anchor, focus: { row: 2000, column: 1 },
    });
    expect(navigateTableSelection(selection, 'End', true, true, 2000, 5000, false)).toEqual({
      anchor: selection.anchor, focus: { row: 2000, column: 4999 },
    });
    expect(navigateTableSelection(selection, 'Home', false, true, 2000, 5000, false)).toEqual({
      anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 },
    });
    expect(navigateTableSelection(null, 'ArrowUp', true, true, 0, 2, false)).toEqual({
      anchor: { row: 0, column: 0 }, focus: { row: 0, column: 0 },
    });
    expect(navigateTableSelection(null, 'ArrowUp', true, true, 0, 0, false)).toBe(null);
    expect(navigateTableSelection(selection, 'c', true, true, 10, 10, false)).toBe(null);
  });

  test('mirrors horizontal data navigation while Home and End follow source order', () => {
    const selection = { anchor: { row: 1, column: 2 }, focus: { row: 1, column: 2 } };
    expect(navigateTableSelection(selection, 'ArrowLeft', true, false, 10, 20, true)?.focus.column).toBe(3);
    expect(navigateTableSelection(selection, 'ArrowRight', true, true, 10, 20, true)?.focus.column).toBe(0);
    expect(navigateTableSelection(selection, 'End', false, false, 10, 20, true)?.focus.column).toBe(19);
  });

  test('copies decoded original values, quotes TSV, escapes HTML, and pads ragged cells', () => {
    const content = 'a,b,c\n"x\ty","line1\nline2","<b>&""quoted"""\nonly';
    const table = parseDelimitedText(content, ',');
    const payload = serializeTableSelection(content, ',', table, {
      anchor: { row: 2, column: 2 }, focus: { row: 0, column: 0 },
    });
    expect(payload.text).toBe('a\tb\tc\n"x\ty"\t"line1\nline2"\t"<b>&""quoted"""\nonly\t\t');
    expect(payload.html).toBe('<table><thead><tr><th scope="col">a</th><th scope="col">b</th><th scope="col">c</th></tr></thead><tbody><tr><td>x\ty</td><td>line1\nline2</td><td>&lt;b&gt;&amp;&quot;quoted&quot;</td></tr><tr><td>only</td><td></td><td></td></tr></tbody></table>');
  });

  test('copies a body rectangle without adding headers, and header-only without a body', () => {
    const content = 'h1\th2\nhidden\t"one\ttwo"\nlast\tend';
    const table = parseDelimitedText(content, '\t');
    expect(serializeTableSelection(content, '\t', table, {
      anchor: { row: 1, column: 1 }, focus: { row: 2, column: 1 },
    })).toEqual({ text: '"one\ttwo"\nend', html: '<table><tbody><tr><td>one\ttwo</td></tr><tr><td>end</td></tr></tbody></table>' });
    expect(serializeTableSelection(content, '\t', table, {
      anchor: { row: 0, column: 1 }, focus: { row: 0, column: 1 },
    })).toEqual({ text: 'h2', html: '<table><thead><tr><th scope="col">h2</th></tr></thead></table>' });
  });

  test('select-all serialization stops at the parsed row cap', () => {
    const content = 'h1,h2\nkept,yes\nomitted,no';
    const table = parseDelimitedText(content, ',', 1);
    expect(table.truncated).toBe(true);
    expect(serializeTableSelection(content, ',', table, {
      anchor: { row: 0, column: 0 }, focus: { row: table.rows.length, column: table.columnCount - 1 },
    }).text).toBe('h1\th2\nkept\tyes');
  });
});
