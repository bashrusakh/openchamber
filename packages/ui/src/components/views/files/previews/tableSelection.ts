/** One ordered endpoint of the browser's native Selection. */
export type NativeSelectionEndpoint = {
  node: Node;
  offset: number;
  childNodes: readonly Node[];
  sourceOffset: number;
  sourceStart: number;
  side: 'start' | 'end';
  structural: boolean;
};

/** A retained native selection as a half-open interval of parsed table cells. */
export type NativeTableSelection = {
  start: number;
  end: number;
  wholeTable: boolean;
  anchor: NativeSelectionEndpoint;
  focus: NativeSelectionEndpoint;
};

type SourceInterval = {
  start: number;
  end: number;
};

type RowInterval = {
  start: number;
  end: number;
};

type ProjectedPoint = {
  sourceOffset: number;
  sourceStart: number;
  structural: boolean;
};

const finiteAttribute = (element: Element, name: string): number | null => {
  const value = element.getAttribute(name);
  if (value === null) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
};

const cellSpan = (cell: Element): number => {
  const span = finiteAttribute(cell, 'colspan');
  return span === null ? 1 : Math.max(1, span);
};

const rowInterval = (row: Element): RowInterval | null => {
  const ariaIndex = finiteAttribute(row, 'aria-rowindex');
  if (ariaIndex !== null && ariaIndex > 0) {
    const index = ariaIndex - 1;
    return { start: index, end: index + 1 };
  }

  const start = finiteAttribute(row, 'data-source-row-start');
  const end = finiteAttribute(row, 'data-source-row-end');
  return start !== null && end !== null && start < end ? { start, end } : null;
};

const cellColumns = (row: Element): Map<Element, { start: number; end: number }> => {
  const columns = new Map<Element, { start: number; end: number }>();
  let cursor = 0;
  for (const cell of Array.from(row.children)) {
    const ariaIndex = finiteAttribute(cell, 'aria-colindex');
    const start = ariaIndex !== null && ariaIndex > 0 ? ariaIndex - 1 : cursor;
    const end = start + (ariaIndex !== null && ariaIndex > 0 ? 1 : cellSpan(cell));
    columns.set(cell, { start, end });
    cursor = end;
  }
  return columns;
};

const cellInterval = (
  cell: Element,
  columnCount: number,
): SourceInterval | null => {
  const row = cell.parentElement;
  if (!row || row.tagName !== 'TR') return null;
  const rows = rowInterval(row);
  if (!rows || rows.end - rows.start !== 1) return null;
  const columns = cellColumns(row).get(cell);
  if (!columns) return null;
  const rowStart = rows.start * columnCount;
  return { start: rowStart + columns.start, end: rowStart + columns.end };
};

const rowIntervalAsCells = (row: Element, columnCount: number): SourceInterval | null => {
  const rows = rowInterval(row);
  return rows
    ? { start: rows.start * columnCount, end: rows.end * columnCount }
    : null;
};

const intervalForElement = (
  element: Element,
  table: HTMLTableElement,
  columnCount: number,
  totalCells: number,
): SourceInterval | null => {
  if (element === table || element.contains(table)) return { start: 0, end: totalCells };
  if (!table.contains(element)) return null;

  if (element.tagName === 'TD' || element.tagName === 'TH') {
    return cellInterval(element, columnCount);
  }
  if (element.tagName === 'TR') return rowIntervalAsCells(element, columnCount);
  if (element.tagName === 'THEAD') return { start: 0, end: columnCount };
  if (element.tagName === 'TBODY') return { start: columnCount, end: totalCells };
  if (element.tagName === 'COLGROUP') return { start: 0, end: 0 };
  if (element.tagName === 'TABLE') return { start: 0, end: totalCells };
  return null;
};

const childInterval = (
  parent: Element,
  child: Node,
  table: HTMLTableElement,
  columnCount: number,
  totalCells: number,
): SourceInterval | null => {
  const ElementConstructor = table.ownerDocument.defaultView?.Element;
  if (!ElementConstructor || !(child instanceof ElementConstructor)) return null;

  if (parent === table && child.tagName === 'COLGROUP') return { start: 0, end: 0 };
  return intervalForElement(child, table, columnCount, totalCells);
};

const boundaryBetweenChildren = (
  parent: Element,
  offset: number,
  table: HTMLTableElement,
  columnCount: number,
  totalCells: number,
): number | null => {
  const children = Array.from(parent.childNodes);
  const position = Math.max(0, Math.min(offset, children.length));
  for (let index = position - 1; index >= 0; index -= 1) {
    const interval = childInterval(parent, children[index]!, table, columnCount, totalCells);
    if (interval && interval.start < interval.end) return interval.end;
  }
  for (let index = position; index < children.length; index += 1) {
    const interval = childInterval(parent, children[index]!, table, columnCount, totalCells);
    if (interval && interval.start < interval.end) return interval.start;
  }
  return intervalForElement(parent, table, columnCount, totalCells)?.start ?? null;
};

const rowBoundary = (
  row: Element,
  offset: number,
  side: 'start' | 'end',
  columnCount: number,
): number | null => {
  const rows = rowInterval(row);
  if (!rows) return null;

  if (rows.end - rows.start !== 1) {
    return offset <= 0
      ? rows.start * columnCount
      : offset >= row.childNodes.length
        ? rows.end * columnCount
        : side === 'start' ? rows.end * columnCount : rows.start * columnCount;
  }

  const cells = cellColumns(row);
  const children = Array.from(row.childNodes);
  const ElementConstructor = row.ownerDocument.defaultView?.Element;
  const position = Math.max(0, Math.min(offset, children.length));
  for (let index = position - 1; index >= 0; index -= 1) {
    const child = children[index]!;
    if (!ElementConstructor || !(child instanceof ElementConstructor)) continue;
    const interval = cells.get(child);
    if (interval) return rows.start * columnCount + interval.end;
  }
  for (let index = position; index < children.length; index += 1) {
    const child = children[index]!;
    if (!ElementConstructor || !(child instanceof ElementConstructor)) continue;
    const interval = cells.get(child);
    if (interval) return rows.start * columnCount + interval.start;
  }
  return rows.start * columnCount;
};

const pointOffset = (
  table: HTMLTableElement,
  container: Node,
  offset: number,
  side: 'start' | 'end',
  columnCount: number,
  totalCells: number,
): ProjectedPoint | null => {
  const ElementConstructor = table.ownerDocument.defaultView?.Element;
  const containerElement = ElementConstructor && container instanceof ElementConstructor
    ? container
    : null;
  const element = containerElement ?? container.parentElement;
  const cell = element?.closest('td, th') ?? null;

  if (cell && table.contains(cell)) {
    const interval = cellInterval(cell, columnCount);
    if (interval) {
      // Empty spacer cells have no parsed text to select. Treat a point in one
      // as its nearest source cut instead of retaining the whole represented gap.
      if (cell.getAttribute('aria-hidden') === 'true') {
        return {
          sourceOffset: side === 'start' ? interval.end : interval.start,
          sourceStart: interval.start,
          structural: true,
        };
      }
      return {
        sourceOffset: side === 'start' ? interval.start : interval.end,
        sourceStart: side === 'start' ? interval.start : interval.end,
        structural: false,
      };
    }

    const rows = cell.parentElement ? rowInterval(cell.parentElement) : null;
    if (rows) {
      return {
        sourceOffset: side === 'start'
          ? rows.end * columnCount
          : rows.start * columnCount,
        sourceStart: rows.start * columnCount,
        structural: true,
      };
    }
  }

  if (containerElement?.tagName === 'TR' && table.contains(containerElement)) {
    const sourceOffset = rowBoundary(containerElement, offset, side, columnCount);
    const rows = rowInterval(containerElement);
    return sourceOffset === null || !rows
      ? null
      : { sourceOffset, sourceStart: rows.start * columnCount, structural: true };
  }

  if (containerElement && (
    containerElement === table
    || table.contains(containerElement)
    || containerElement.contains(table)
  )) {
    const sourceOffset = boundaryBetweenChildren(
      containerElement,
      offset,
      table,
      columnCount,
      totalCells,
    );
    const sourceStart = intervalForElement(containerElement, table, columnCount, totalCells)?.start;
    return sourceOffset === null
      ? null
      : { sourceOffset, sourceStart: sourceStart ?? sourceOffset, structural: true };
  }

  return null;
};

/**
 * Projects the browser's live Range to parsed cell coverage represented by
 * the committed sparse table DOM.
 */
export const projectNativeTableSelection = (
  table: HTMLTableElement,
  range: Range,
  selection: Selection,
  bodyRowCount: number,
  columnCount: number,
): NativeTableSelection | null => {
  if (columnCount <= 0) return null;
  const totalCells = (bodyRowCount + 1) * columnCount;
  const startPoint = pointOffset(
    table,
    range.startContainer,
    range.startOffset,
    'start',
    columnCount,
    totalCells,
  ) ?? (range.comparePoint(table, 0) === 0
    ? { sourceOffset: 0, sourceStart: 0, structural: false }
    : null);
  const endPoint = pointOffset(
    table,
    range.endContainer,
    range.endOffset,
    'end',
    columnCount,
    totalCells,
  ) ?? (range.comparePoint(table, table.childNodes.length) === 0
    ? { sourceOffset: totalCells, sourceStart: totalCells, structural: false }
    : null);
  if (startPoint === null || endPoint === null || startPoint.sourceOffset > endPoint.sourceOffset) {
    return null;
  }

  const clampedStart = Math.max(0, Math.min(startPoint.sourceOffset, totalCells));
  const clampedEnd = Math.max(clampedStart, Math.min(endPoint.sourceOffset, totalCells));
  const anchorIsStart = selection.anchorNode === range.startContainer
    && selection.anchorOffset === range.startOffset;
  const orderedStart: NativeSelectionEndpoint = {
    node: range.startContainer,
    offset: range.startOffset,
    childNodes: Array.from(range.startContainer.childNodes),
    sourceOffset: startPoint.sourceOffset,
    sourceStart: startPoint.sourceStart,
    side: 'start',
    structural: startPoint.structural,
  };
  const orderedEnd: NativeSelectionEndpoint = {
    node: range.endContainer,
    offset: range.endOffset,
    childNodes: Array.from(range.endContainer.childNodes),
    sourceOffset: endPoint.sourceOffset,
    sourceStart: endPoint.sourceStart,
    side: 'end',
    structural: endPoint.structural,
  };
  return {
    start: clampedStart,
    end: clampedEnd,
    wholeTable: clampedStart === 0 && clampedEnd === totalCells,
    anchor: anchorIsStart ? orderedStart : orderedEnd,
    focus: anchorIsStart ? orderedEnd : orderedStart,
  };
};

/** Finds the child offset that still denotes an endpoint's captured source cut. */
export const resolveNativeSelectionEndpointOffset = (
  table: HTMLTableElement,
  endpoint: NativeSelectionEndpoint,
  bodyRowCount: number,
  columnCount: number,
): number | null => {
  if (!endpoint.structural) return endpoint.offset;
  const ElementConstructor = table.ownerDocument.defaultView?.Element;
  if (!ElementConstructor || !(endpoint.node instanceof ElementConstructor)) return null;
  const element = endpoint.node;
  if (element !== table && !table.contains(element) && !element.contains(table)) return null;
  const totalCells = (bodyRowCount + 1) * columnCount;
  for (let offset = 0; offset <= element.childNodes.length; offset += 1) {
    const point = pointOffset(
      table,
      element,
      offset,
      endpoint.side,
      columnCount,
      totalCells,
    );
    if (point?.sourceOffset === endpoint.sourceOffset) return offset;
  }
  return null;
};
