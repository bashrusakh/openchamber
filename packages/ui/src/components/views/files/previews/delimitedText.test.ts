import { describe, expect, test } from 'bun:test';

import { delimiterForPath, parseDelimitedText } from './delimitedText';

describe('parseDelimitedText', () => {
  test('splits a plain CSV into a header and rows, ignoring the trailing newline', () => {
    const table = parseDelimitedText('name,age\nAda,36\nLinus,54\n', ',');
    expect(table.header).toEqual(['name', 'age']);
    expect(table.rows).toEqual([['Ada', '36'], ['Linus', '54']]);
    expect(table.totalRows).toBe(2);
    expect(table.columnCount).toBe(2);
    expect(table.truncated).toBe(false);
  });

  test('keeps delimiters, newlines and doubled quotes inside quoted fields', () => {
    const table = parseDelimitedText('id,note\r\n1,"a, b"\r\n2,"line one\nline two"\r\n3,"say ""hi"""\r\n', ',');
    expect(table.rows).toEqual([['1', 'a, b'], ['2', 'line one\nline two'], ['3', 'say "hi"']]);
  });

  test('reads TSV by path and a UTF-8 BOM does not leak into the first header', () => {
    expect(delimiterForPath('/x/data.tsv')).toBe('\t');
    expect(delimiterForPath('/x/data.CSV')).toBe(',');
    const table = parseDelimitedText('﻿a\tb\n1\t2\n', '\t');
    expect(table.header).toEqual(['a', 'b']);
    expect(table.rows).toEqual([['1', '2']]);
  });

  test('counts every row but keeps only the capped ones', () => {
    const lines = ['n', ...Array.from({ length: 10 }, (_, index) => String(index))];
    const table = parseDelimitedText(lines.join('\n'), ',', 4);
    expect(table.rows).toHaveLength(4);
    expect(table.totalRows).toBe(10);
    expect(table.truncated).toBe(true);
  });

  test('a ragged file reports the widest row and an empty file has no columns', () => {
    expect(parseDelimitedText('a,b\n1,2,3\n', ',').columnCount).toBe(3);
    expect(parseDelimitedText('', ',')).toEqual({ header: [], rows: [], totalRows: 0, columnCount: 0, truncated: false });
  });

  // The cases below pin the whole result of the parser, not one field of it.
  // Each one is a shape a real export has, so a change in any of them shows
  // up as a different table in every app that previews a CSV.

  describe('plain files and line endings', () => {
    test('a trailing newline does not add a row', () => {
      expect(parseDelimitedText('name,age\nAda,36\n', ',')).toEqual({
        header: ['name', 'age'],
        rows: [['Ada', '36']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('the last row without a newline is still a row', () => {
      expect(parseDelimitedText('name,age\nAda,36', ',')).toEqual({
        header: ['name', 'age'],
        rows: [['Ada', '36']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a carriage return and a line feed together end one row', () => {
      expect(parseDelimitedText('a,b\r\n1,2\r\n', ',')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a carriage return on its own ends a row', () => {
      expect(parseDelimitedText('a,b\r1,2\r', ',')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('the line endings in one file may differ', () => {
      expect(parseDelimitedText('a,b\r\n1,2\n3,4\r', ',').rows).toEqual([['1', '2'], ['3', '4']]);
    });

    test('a file with one cell and no newline is a header of one column', () => {
      expect(parseDelimitedText('x', ',')).toEqual({
        header: ['x'],
        rows: [],
        totalRows: 0,
        columnCount: 1,
        truncated: false,
      });
    });

    test('an empty file has no header and no columns', () => {
      expect(parseDelimitedText('', ',')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('a file of nothing but newlines has no records', () => {
      expect(parseDelimitedText('\n\n', ',')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('the spaces around a value are part of it', () => {
      expect(parseDelimitedText(' a , b \n', ',').header).toEqual([' a ', ' b ']);
    });
  });

  describe('quoted fields', () => {
    test('a quoted field holds the delimiter', () => {
      expect(parseDelimitedText('id,note\n1,"a, b"\n', ',').rows).toEqual([['1', 'a, b']]);
    });

    test('a quoted field holds a newline', () => {
      expect(parseDelimitedText('id,note\n1,"line one\nline two"\n', ',').rows)
        .toEqual([['1', 'line one\nline two']]);
    });

    test('a doubled quote inside a quoted field is one quote', () => {
      expect(parseDelimitedText('id,note\n1,"say ""hi"""\n', ',').rows).toEqual([['1', 'say "hi"']]);
    });

    test('a quoted field may be empty', () => {
      expect(parseDelimitedText('a,"",b\n', ',').header).toEqual(['a', '', 'b']);
    });

    test('a quoted field that is the whole file holds one empty cell', () => {
      expect(parseDelimitedText('""', ',')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });

    test('a lone quote is a record with one empty cell', () => {
      expect(parseDelimitedText('"', ',')).toEqual({
        header: [''],
        rows: [],
        totalRows: 0,
        columnCount: 1,
        truncated: false,
      });
    });

    test('three quotes are one cell holding a quote', () => {
      expect(parseDelimitedText('"""', ',').header).toEqual(['"']);
    });

    test('the quotes around a value are dropped', () => {
      expect(parseDelimitedText('"a","b"\n', ',').header).toEqual(['a', 'b']);
    });

    test('text after a closing quote joins the same cell', () => {
      expect(parseDelimitedText('"a"b\n', ',').header).toEqual(['ab']);
    });

    test('a quote that is never closed runs to the end of the file', () => {
      expect(parseDelimitedText('a,"b', ',').header).toEqual(['a', 'b']);
      expect(parseDelimitedText('a,"b\nc', ',').header).toEqual(['a', 'b\nc']);
    });

    test('a quote in the middle of an unquoted field is dropped and the field runs on', () => {
      expect(parseDelimitedText('a"b,c', ',').header).toEqual(['ab,c']);
      expect(parseDelimitedText('a"b,c\n', ',').header).toEqual(['ab,c\n']);
      expect(parseDelimitedText('ab"cd,ef', ',').header).toEqual(['abcd,ef']);
    });

    test('a quoted field with a newline is followed by the cells after it', () => {
      expect(parseDelimitedText('a,"b\nc",d\n', ',').header).toEqual(['a', 'b\nc', 'd']);
    });
  });

  describe('the byte order mark', () => {
    test('a byte order mark does not reach the first header', () => {
      expect(parseDelimitedText('﻿a,b\n1,2\n', ',')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a byte order mark before carriage return line feeds is dropped as well', () => {
      expect(parseDelimitedText('﻿a,b\r\n1,2\r\n', ',').header).toEqual(['a', 'b']);
    });

    test('a file that is only a byte order mark is empty', () => {
      expect(parseDelimitedText('﻿', ',')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });
  });

  describe('the shape of the file', () => {
    test('a ragged file reports the widest record it holds', () => {
      expect(parseDelimitedText('a,b\n1,2,3\n', ',')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2', '3']],
        totalRows: 1,
        columnCount: 3,
        truncated: false,
      });
    });

    test('a record may be shorter than the header', () => {
      expect(parseDelimitedText('a,b,c\n1,2\n', ',')).toEqual({
        header: ['a', 'b', 'c'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 3,
        truncated: false,
      });
    });

    test('an empty field between two delimiters is a cell', () => {
      expect(parseDelimitedText('a,,b\n', ',').header).toEqual(['a', '', 'b']);
    });

    test('a trailing delimiter is a trailing empty cell', () => {
      expect(parseDelimitedText('a,b,\n', ',').header).toEqual(['a', 'b', '']);
      expect(parseDelimitedText('a,\n', ',').header).toEqual(['a', '']);
    });

    test('a file of nothing but delimiters holds empty cells', () => {
      expect(parseDelimitedText(',,\n', ',').header).toEqual(['', '', '']);
      expect(parseDelimitedText(',,', ',').header).toEqual(['', '', '']);
    });

    test('a blank line between two records is not a record', () => {
      expect(parseDelimitedText('a,b\n\n1,2\n', ',')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a blank line before or after the records is not a record either', () => {
      expect(parseDelimitedText('\na,b\n', ',').header).toEqual(['a', 'b']);
      expect(parseDelimitedText('a,b\n\n', ',').header).toEqual(['a', 'b']);
      expect(parseDelimitedText('\n\n\n', ',')).toEqual({
        header: [],
        rows: [],
        totalRows: 0,
        columnCount: 0,
        truncated: false,
      });
    });
  });

  describe('tab separated files', () => {
    test('a tab separates the cells', () => {
      expect(parseDelimitedText('a\tb\n1\t2\n', '\t')).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2']],
        totalRows: 1,
        columnCount: 2,
        truncated: false,
      });
    });

    test('a quoted field holds a tab', () => {
      expect(parseDelimitedText('a\tb\n1\t"x\ty"\n', '\t').rows).toEqual([['1', 'x\ty']]);
    });

    test('a blank line between the records is not a record', () => {
      expect(parseDelimitedText('a\tb\n\n1\t2\n', '\t').rows).toEqual([['1', '2']]);
    });
  });

  describe('the row cap', () => {
    const fiveRows = 'h\n1\n2\n3\n4\n5\n';

    test('the cap counts the rows under the header', () => {
      expect(parseDelimitedText(fiveRows, ',', 2)).toEqual({
        header: ['h'],
        rows: [['1'], ['2']],
        totalRows: 5,
        columnCount: 1,
        truncated: true,
      });
    });

    test('the header is kept even when the cap is zero', () => {
      expect(parseDelimitedText(fiveRows, ',', 0)).toEqual({
        header: ['h'],
        rows: [],
        totalRows: 5,
        columnCount: 1,
        truncated: true,
      });
    });

    test('every row is counted even when none is kept', () => {
      expect(parseDelimitedText(fiveRows, ',', 0).totalRows).toBe(5);
    });

    test('a cap above the row count keeps everything', () => {
      expect(parseDelimitedText(fiveRows, ',', 100)).toEqual({
        header: ['h'],
        rows: [['1'], ['2'], ['3'], ['4'], ['5']],
        totalRows: 5,
        columnCount: 1,
        truncated: false,
      });
    });

    test('a cap of one keeps one row', () => {
      expect(parseDelimitedText(fiveRows, ',', 1).rows).toEqual([['1']]);
    });

    test('a cap below zero keeps the header and no row', () => {
      expect(parseDelimitedText('h\n1\n2\n', ',', -1)).toEqual({
        header: ['h'],
        rows: [],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });

    test('a cap that is not a whole number keeps the rows under it', () => {
      expect(parseDelimitedText('h\n1\n2\n3\n4\n', ',', 2.5).rows).toEqual([['1'], ['2']]);
    });

    test('a cap that is not a number keeps the header and no row', () => {
      expect(parseDelimitedText('h\n1\n2\n3\n', ',', Number.NaN).rows).toEqual([]);
    });

    test('the width of a row that was dropped does not count', () => {
      expect(parseDelimitedText('a,b\n1,2,3\n4,5\n', ',', 1)).toEqual({
        header: ['a', 'b'],
        rows: [['1', '2', '3']],
        totalRows: 2,
        columnCount: 3,
        truncated: true,
      });
    });

    test('a blank line does not use up the cap', () => {
      expect(parseDelimitedText('h\n\n1\n\n2\n', ',', 1)).toEqual({
        header: ['h'],
        rows: [['1']],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });

    test('a quoted newline stays inside its row', () => {
      expect(parseDelimitedText('h\n"a\nb"\n2\n', ',', 1)).toEqual({
        header: ['h'],
        rows: [['a\nb']],
        totalRows: 2,
        columnCount: 1,
        truncated: true,
      });
    });
  });
});
