/**
 * CSV/TSV parsing for the table preview.
 *
 * RFC 4180 rules: a field wrapped in double quotes may hold the delimiter,
 * newlines and doubled quotes. The parser is streaming over one string so a
 * large export never builds an intermediate array of lines, and it stops
 * filling rows past the cap while still counting them, so the preview can say
 * "2,000 of 48,210 rows" without holding all of them.
 *
 * A field is cut out of the source with slice() instead of being grown one
 * character at a time, and the characters that end a field are found by
 * reading the source, so the file is walked once and every field costs one
 * slice.
 */

type DelimitedTable = {
  header: string[];
  rows: string[][];
  /** Every data row in the file, including the ones not kept. */
  totalRows: number;
  columnCount: number;
  truncated: boolean;
};

const DEFAULT_TABLE_ROW_CAP = 2_000;

const QUOTE_CODE = 34;
const LINE_FEED_CODE = 10;
const CARRIAGE_RETURN_CODE = 13;

export const delimiterForPath = (filePath: string): ',' | '\t' => (
  filePath.toLowerCase().endsWith('.tsv') ? '\t' : ','
);

export const parseDelimitedText = (
  content: string,
  delimiter: ',' | '\t',
  rowCap: number = DEFAULT_TABLE_ROW_CAP,
): DelimitedTable => {
  const source = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const length = source.length;
  const delimiterCode = delimiter.charCodeAt(0);

  // The records the preview holds: the header and the rows under the cap.
  const records: string[][] = [];
  let totalRecords = 0;

  let record: string[] = [];
  let field = '';
  /** Whether the field being read has no characters in it yet. */
  let fieldIsEmpty = true;
  /** How many fields the record being read has, the last one still open. */
  let fieldsInRecord = 0;
  /** Whether the record holds a quote or a delimiter, which is what tells a
   * record apart from a blank line. */
  let recordHasContent = false;
  let quoted = false;
  /** A record past the cap is counted but not held. */
  let collecting = true;

  let position = 0;

  while (position < length) {
    if (quoted) {
      // Inside a quoted field only the closing quote is special.
      let at = position;
      while (at < length && source.charCodeAt(at) !== QUOTE_CODE) at += 1;
      if (at > position) {
        if (collecting) {
          const content = source.slice(position, at);
          field = fieldIsEmpty ? content : field + content;
        }
        fieldIsEmpty = false;
      }
      if (at >= length) {
        // The file ends inside the quoted field, so the rest is its content.
        position = length;
        break;
      }
      if (source.charCodeAt(at + 1) === QUOTE_CODE) {
        // A doubled quote inside a quoted field is one literal quote.
        if (collecting) field = fieldIsEmpty ? '"' : field + '"';
        fieldIsEmpty = false;
        position = at + 2;
        continue;
      }
      quoted = false;
      position = at + 1;
      continue;
    }

    // The field runs up to the next delimiter, quote or line break.
    let at = position;
    while (at < length) {
      const code = source.charCodeAt(at);
      if (code === delimiterCode || code === QUOTE_CODE || code === LINE_FEED_CODE || code === CARRIAGE_RETURN_CODE) {
        break;
      }
      at += 1;
    }
    if (at > position) {
      if (collecting) {
        const content = source.slice(position, at);
        field = fieldIsEmpty ? content : field + content;
      }
      fieldIsEmpty = false;
    }
    if (at >= length) {
      // The rest of the file is the last field.
      position = length;
      break;
    }

    const code = source.charCodeAt(at);
    if (code === QUOTE_CODE) {
      quoted = true;
      recordHasContent = true;
      position = at + 1;
      continue;
    }
    if (code === delimiterCode) {
      if (collecting) record.push(field);
      field = '';
      fieldIsEmpty = true;
      fieldsInRecord += 1;
      recordHasContent = true;
      position = at + 1;
      continue;
    }
    // A line break ends the record. A carriage return followed by a line feed
    // is one break.
    position = code === CARRIAGE_RETURN_CODE && source.charCodeAt(at + 1) === LINE_FEED_CODE
      ? at + 2
      : at + 1;
    const isBlank = !recordHasContent && fieldIsEmpty;
    if (collecting) record.push(field);
    field = '';
    fieldIsEmpty = true;
    // A trailing newline is not an empty record; a single empty field is only
    // a record when something else on that line said so.
    if (!isBlank) {
      if (totalRecords === 0 || records.length <= rowCap) records.push(record);
      totalRecords += 1;
    }
    record = [];
    fieldsInRecord = 0;
    recordHasContent = false;
    // The same rule the record is held by, read before the record is read:
    // the counts do not move until the record ends.
    collecting = totalRecords === 0 || records.length <= rowCap;
  }

  if (!fieldIsEmpty || fieldsInRecord > 0 || quoted) {
    const isBlank = !recordHasContent && fieldIsEmpty;
    if (collecting) record.push(field);
    if (!isBlank) {
      if (totalRecords === 0 || records.length <= rowCap) records.push(record);
      totalRecords += 1;
    }
  }

  const header = records[0] ?? [];
  const rows = records.slice(1);
  const columnCount = records.reduce((max, entry) => Math.max(max, entry.length), 0);
  const totalRows = Math.max(0, totalRecords - 1);
  return {
    header,
    rows,
    totalRows,
    columnCount,
    truncated: rows.length < totalRows,
  };
};
