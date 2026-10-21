import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import { act, useLayoutEffect, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { I18nProvider } from '@/lib/i18n';

// The number of times the preview walks over the cells of the file to find
// the width every column asks for. That walk is the part of the preview that
// grows with the file, so it is counted here.
const tableLayout = await import('./tableLayout');
const measureTableColumns = tableLayout.measureTableColumns;
let cellWalks = 0;
/** The latin flag the preview measured the columns with. */
let lastAsciiOnly: boolean | null = null;
mock.module('./tableLayout', () => ({
  ...tableLayout,
  measureTableColumns: (...args: Parameters<typeof measureTableColumns>) => {
    cellWalks += 1;
    lastAsciiOnly = args[4];
    return measureTableColumns(...args);
  },
}));

// The preview is loaded after the mock, so it is the walk of the preview that
// is counted.
const { TableArtifact } = await import('./TableArtifact');

/** What the preview reads from the computed style of its probe. */
type ComputedStyleDouble = Pick<
  CSSStyleDeclaration,
  | 'direction'
  | 'paddingLeft'
  | 'paddingRight'
  | 'borderInlineEndWidth'
  | 'borderLeftWidth'
  | 'borderRightWidth'
  | 'maxWidth'
>;

/** The size of the box the preview is rendered in. */
const VIEWPORT_WIDTH = 800;
const VIEWPORT_HEIGHT = 600;
/**
 * The height of a row with text: a line, the cell's padding and its bottom
 * border. It is the height every row is given.
 */
const ROW_HEIGHT = 30;
/**
 * The height of a row without text: it has no line in it, so only the
 * padding and the border are left.
 */
const EMPTY_ROW_HEIGHT = 9;
/** The height of the line the text of a cell sits on. */
const LINE_HEIGHT = 21;
/** The rows kept mounted above and below the viewport. */
const ROW_OVERSCAN = 6;
/** The columns kept mounted beside the viewport. */
const COLUMN_OVERSCAN = 2;
/** The width of a column of four characters, the way the preview plans with. */
const COLUMN_WIDTH = 4 * 7.5 + 17;
/**
 * The advance a browser measures in Chromium. The measured text box is
 * rounded up to the next 1/64 px, so the measured advance is a hair above
 * the one the layout uses.
 */
const MEASURED_ADVANCE = 7.50006103515625;
/** The characters the measuring probe draws. */
const PROBE_CHARACTER_COUNT = 256;
/** The width of the probe's text, the way a browser measures it. */
let probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE;
/**
 * The width the browser gives a character of the file, by the character.
 *
 * The preview draws every character outside latin on its own and reads the
 * width back, so the test hands it the width of the characters it wants the
 * preview to know about.
 */
const characterAdvances = new Map<string, number>();

/**
 * The observer the preview uses for the font and for the size of the panel.
 * happy-dom has none, so the test drives it by hand.
 */
class FakeResizeObserver implements ResizeObserver {
  /** Every observer the preview has made. */
  static instances: FakeResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  private watching = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    FakeResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.watching = false;
  }

  /** The resize the browser would report. */
  fire(): void {
    if (!this.watching) return;
    this.callback([], this);
  }
}

/**
 * A resize observer that reports what the browser reports.
 *
 * The browser reports the content box of the element it observes and it
 * reports a resize only when that box changed. An inline box has no content
 * box of its own, so the browser reports an empty one for it and never
 * reports a resize for it, whatever the text inside it measures. This
 * double is used by the test that watches the probe's text, which has to be
 * a box of its own for the observer to see a change of the font.
 */
class ContentBoxResizeObserver implements ResizeObserver {
  /** Every observer the preview has made. */
  static instances: ContentBoxResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  private readonly targets = new Set<Element>();
  /** The box the browser reported the last time it looked. */
  private readonly reported = new Map<Element, { width: number; height: number }>();
  private watching = true;

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    ContentBoxResizeObserver.instances.push(this);
  }

  observe(target: Element): void {
    this.targets.add(target);
    this.reported.set(target, observedBox(target));
  }

  unobserve(target: Element): void {
    this.targets.delete(target);
    this.reported.delete(target);
  }

  disconnect(): void {
    this.targets.clear();
    this.reported.clear();
    this.watching = false;
  }

  /** The resize the browser would report. */
  fire(): void {
    if (!this.watching) return;
    let changed = false;
    for (const target of this.targets) {
      const box = observedBox(target);
      const previous = this.reported.get(target);
      if (previous && previous.width === box.width && previous.height === box.height) continue;
      this.reported.set(target, box);
      changed = true;
    }
    if (!changed) return;
    this.callback([], this);
  }
}

const buildCsv = (rows: number, columns: number): string => {
  const lines: string[] = [];
  for (let row = 0; row < rows; row += 1) {
    const cells: string[] = [];
    for (let column = 0; column < columns; column += 1) {
      cells.push(`r${row}c${column}`.padEnd(4, 'x'));
    }
    lines.push(cells.join(','));
  }
  return lines.join('\n');
};

/**
 * A table whose first data row holds nothing but delimiters. Such a row has
 * no text in it, so it is shorter than the rows around it.
 */
const buildCsvWithAnEmptyRow = (rows: number, columns: number): string => {
  const lines = buildCsv(rows, columns).split('\n');
  lines.splice(1, 0, Array.from({ length: columns }, () => '').join(','));
  return lines.join('\n');
};

/**
 * A table whose first columns have no header.
 *
 * A header cell without text has no line in it, so a header row that takes
 * its height from the cells in view collapses to the padding and the border.
 */
const buildCsvWithEmptyHeaders = (rows: number, columns: number, emptyColumns: number): string => {
  const header = Array.from({ length: columns }, (_, column) => (
    column < emptyColumns ? '' : `h${String(column).padStart(3, '0')}`
  ));
  const lines = buildCsv(rows - 1, columns).split('\n');
  return [header.join(','), ...lines].join('\n');
};

/** A table whose columns are all four characters wide, so the model is exact. */
const buildUniformCsv = (columns: number): string => {
  const cells: string[] = [];
  for (let column = 0; column < columns; column += 1) {
    cells.push(`c${String(column).padStart(3, '0')}`);
  }
  return `${cells.join(',')}\n${cells.join(',')}`;
};

/**
 * The height of a row, the way the browser lays it out.
 *
 * A row takes the height it asks for, and a row whose cells hold no text is
 * only as tall as its padding and its border.
 */
const rowHeight = (row: Element): number => {
  const asked = row instanceof HTMLElement ? Number.parseFloat(row.style.height) : 0;
  const empty = Array.from(row.querySelectorAll('td, th')).every((cell) => !cell.textContent);
  return Math.max(asked || 0, empty ? EMPTY_ROW_HEIGHT : ROW_HEIGHT);
};

/**
 * What the preview reads from the box of an element. happy-dom has no
 * layout, so the boxes the preview measures are given the sizes a browser
 * would report.
 */
const measureBox = (element: Element) => {
  if (element.tagName === 'TR') {
    return { width: 0, height: rowHeight(element) };
  }
  if (element.tagName === 'THEAD') {
    // The header is as tall as the row it holds.
    const row = element.querySelector('tr');
    return { width: 0, height: row ? rowHeight(row) : 0 };
  }
  if (element.tagName === 'SPAN') {
    // The probe that holds the text measures the advance of a character. The
    // probe that stands for a cell measures the height of a row with text.
    const text = element.textContent ?? '';
    if (text.length === PROBE_CHARACTER_COUNT) {
      return { width: probeTextWidth, height: LINE_HEIGHT };
    }
    // A character of the file is drawn on its own, and the browser reports
    // the width it takes in the font it has.
    const advance = characterAdvances.get(text);
    if (advance !== undefined) {
      return { width: advance, height: ROW_HEIGHT };
    }
    return { width: 0, height: ROW_HEIGHT };
  }
  return { width: 0, height: 0 };
};

/**
 * The box the browser reports for an element it observes.
 *
 * The browser reports the content box of the element, and an inline box has
 * no content box of its own: the browser reports an empty one for it,
 * whatever the text inside it measures. An inline block has a content box of
 * its own, and that box follows the font.
 */
const observedBox = (element: Element) => {
  // happy-dom does not apply the stylesheets, so the display of an element
  // is read from the class that asks for it.
  const isInline = element.tagName === 'SPAN' && !element.classList.contains('inline-block');
  return isInline ? { width: 0, height: 0 } : measureBox(element);
};

/** The props of the watcher that records the document after every commit. */
type CommitWatcherProps = {
  onCommit: () => void;
  children?: ReactNode;
};

/**
 * The preview with a parent that records the document after every commit.
 *
 * The layout effect of a parent runs after the layout effects of its
 * children, so the record holds the document as the commit left it, before
 * the preview has corrected its window.
 */
const CommitWatcher = ({ onCommit, children }: CommitWatcherProps) => {
  useLayoutEffect(() => {
    onCommit();
  });
  return <>{children}</>;
};

describe('TableArtifact', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;
  let scrollTop = 0;
  let scrollLeft = 0;
  /** The width of the box the preview is rendered in. */
  let viewportWidth = VIEWPORT_WIDTH;
  /** The padding on each side of a cell, as the preview reads it. */
  let cellPadding = 8;
  /** The border on the inline end of a cell, as the preview reads it. */
  let cellBorder = 1;
  /**
   * Whether the runtime resolves the logical side of the border. A runtime
   * that does not knows only the physical sides.
   */
  let logicalBorderResolves = true;

  beforeEach(() => {
    windowInstance = new Window();
    FakeResizeObserver.instances = [];
    ContentBoxResizeObserver.instances = [];
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE;
    characterAdvances.clear();
    cellWalks = 0;
    lastAsciiOnly = null;
    viewportWidth = VIEWPORT_WIDTH;
    cellPadding = 8;
    cellBorder = 1;
    logicalBorderResolves = true;
    // happy-dom does not apply the stylesheets, so the values the preview
    // reads from the computed style are given the ones its own classes ask
    // for, and the direction is the one the root element carries.
    const computedStyle = (): ComputedStyleDouble => {
      const direction = windowInstance.document.documentElement.getAttribute('dir');
      const rtl = direction === 'rtl';
      return {
        direction: rtl ? 'rtl' : 'ltr',
        paddingLeft: `${cellPadding}px`,
        paddingRight: `${cellPadding}px`,
        // The border of a cell is on its inline end: the right edge of a
        // left-to-right document, the left edge of a right-to-left one.
        borderInlineEndWidth: logicalBorderResolves ? `${cellBorder}px` : '',
        borderRightWidth: rtl ? '0px' : `${cellBorder}px`,
        borderLeftWidth: rtl ? `${cellBorder}px` : '0px',
        maxWidth: '512px',
      };
    };
    // The preview measures the character width from the width of the probe's
    // text and the row height from the probe that stands for a cell, the way
    // a browser measures them.
    Object.defineProperty(windowInstance.Element.prototype, 'getBoundingClientRect', {
      configurable: true,
      value: function (this: Element) {
        const box = measureBox(this);
        return {
          width: box.width,
          height: box.height,
          top: 0,
          left: 0,
          right: box.width,
          bottom: box.height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        };
      },
    });
    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      MutationObserver: windowInstance.MutationObserver,
      ResizeObserver: FakeResizeObserver,
      getComputedStyle: computedStyle,
      IS_REACT_ACT_ENVIRONMENT: true,
    });
    // The preview reads the box it is in and where that box is scrolled to.
    Object.defineProperty(windowInstance.HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: () => viewportWidth,
    });
    Object.defineProperty(windowInstance.HTMLElement.prototype, 'clientHeight', {
      configurable: true,
      get: () => VIEWPORT_HEIGHT,
    });
    Object.defineProperty(windowInstance.Element.prototype, 'scrollTop', {
      configurable: true,
      get: () => scrollTop,
      set: (value: number) => { scrollTop = value; },
    });
    Object.defineProperty(windowInstance.Element.prototype, 'scrollLeft', {
      configurable: true,
      get: () => scrollLeft,
      set: (value: number) => { scrollLeft = value; },
    });
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    scrollTop = 0;
    scrollLeft = 0;
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    await windowInstance.happyDOM.close();
  });

  const render = async (content: string, sizeBytes: number | null = null) => {
    await act(async () => {
      root.render(
        <I18nProvider>
          <TableArtifact path="/repo/data.csv" content={content} sizeBytes={sizeBytes} />
        </I18nProvider>,
      );
    });
    // The language sets the direction on the root element, and the preview
    // answers that in a task of its own. The answer has to land inside an
    // act, or the update lands outside one.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };

  const scrollTo = async (top: number, left = 0) => {
    scrollTop = top;
    scrollLeft = left;
    const scroller = windowInstance.document.querySelector('.overflow-auto');
    await act(async () => {
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
    });
  };

  /** The resize the browser would report, with the panel at its new width. */
  const resize = async (width: number) => {
    viewportWidth = width;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });
  };

  const dataCells = () => Array.from(host.querySelectorAll('td[title]'));

  /**
   * The columns the preview has in the document, in order. The values of the
   * uniform table are named after their column.
   */
  const mountedColumns = (): number[] => {
    const columns = dataCells().map((cell) => Number(cell.getAttribute('title')?.replace(/\D/g, '')));
    return [...new Set(columns)].sort((a, b) => a - b);
  };

  /** The columns from the first to the one before the last. */
  const columnsFrom = (start: number, end: number): number[] => (
    Array.from({ length: end - start }, (_, index) => start + index)
  );

  /** The rows the preview has in the document, by the name of their values. */
  const mountedRowNames = (): string[] => (
    [...new Set(dataCells()
      .map((cell) => (cell.getAttribute('title') ?? '').replace(/c\d+$/, ''))
      .filter((name) => name !== ''))]
  );

  /**
   * The rows the preview has in the document, with the index of the data they
   * hold. The values of the built file are named after their row, and the
   * first line of the file is its header, so the index of the data is one
   * less than the number in the name.
   */
  const mountedRows = (): { index: number; element: Element }[] => (
    Array.from(host.querySelectorAll('tbody tr'))
      .filter((row) => row.querySelector('td[title]'))
      .map((row) => ({
        index: Number((row.querySelector('td[title]')?.getAttribute('title') ?? '').replace(/r(\d+)c\d+$/, '$1')) - 1,
        element: row,
      }))
  );

  /** The stripe a row carries. */
  const stripeOf = (row: Element): string => (
    (row.getAttribute('class') ?? '').includes('bg-[var(--surface-background)]')
      ? 'even'
      : 'odd'
  );

  /** True when the cell keeps the border on its inline end. */
  const keepsEndBorder = (cell: Element | null): boolean => (
    (cell?.getAttribute('class') ?? '').includes('border-e')
    && !(cell?.getAttribute('class') ?? '').includes('border-e-0')
  );

  /**
   * The classes that decide the padding and the border of a cell. The last
   * column does not have the border, so it is left out.
   */
  const chromeClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('px-') || (name.startsWith('border-e') && name !== 'border-e-0'))
      .sort()
  );

  /**
   * The classes that decide the box of a cell: the padding around its text
   * and the border under it. The font size is the one of the table, which
   * both kinds of cell inherit.
   */
  const boxClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('px-') || name.startsWith('py-') || name === 'border-b')
      .sort()
  );

  /** The height of the header row, the way the browser lays it out. */
  const headerRowHeight = (): number => {
    const row = host.querySelector('thead tr');
    return row ? row.getBoundingClientRect().height : 0;
  };

  /** The height of the sticky header, the way the browser lays it out. */
  const stickyHeaderHeight = (): number => {
    const head = host.querySelector('thead');
    return head ? head.getBoundingClientRect().height : 0;
  };

  /** The border classes of a cell. */
  const borderClasses = (element: Element | null): string[] => (
    (element?.getAttribute('class') ?? '')
      .split(/\s+/)
      .filter((name) => name.startsWith('border-'))
      .sort()
  );

  /**
   * The spacer cells of the first mounted row: the ones that stand for the
   * columns beside the window.
   */
  const columnSpacers = (): Element[] => {
    const row = Array.from(host.querySelectorAll('tbody tr'))
      .find((candidate) => candidate.querySelector('td[title]'));
    if (!row) return [];
    return Array.from(row.children).filter((cell) => !cell.hasAttribute('title'));
  };

  test('mounts only the cells in view of a wide export', async () => {
    await render(buildCsv(2_100, 50));

    const cells = dataCells();
    const maxRows = Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + 1 + 2 * ROW_OVERSCAN;
    const maxColumns = Math.ceil(VIEWPORT_WIDTH / COLUMN_WIDTH) + 2 * COLUMN_OVERSCAN;
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(maxRows * maxColumns);
    // The rows that are not in view are not in the document.
    expect(host.querySelectorAll('td').length).toBeLessThan(2_000);
  });

  test('keeps the header, its scope and the title on every cell', async () => {
    await render(buildCsv(20, 4));

    const headers = Array.from(host.querySelectorAll('th[scope="col"]'));
    expect(headers.length).toBeGreaterThan(0);
    expect(headers[0]?.textContent).toBe('r0c0');
    const cells = dataCells();
    expect(cells.length).toBeGreaterThan(0);
    expect(cells[0]?.getAttribute('title')).toBe(cells[0]?.textContent);
  });

  test('states the rows, the columns and the cap in the meta line', async () => {
    await render(buildCsv(2_100, 50), 1_234);

    const meta = host.querySelector('.typography-meta')?.textContent ?? '';
    expect(meta).toContain('2099 rows · 50 columns');
    expect(meta).toContain('Showing the first 2000 of 2099 rows');
    expect(meta).toContain('1.2 KB');
  });

  test('reaches the last retained row when the table is scrolled to the end', async () => {
    await render(buildCsv(2_100, 50));

    await scrollTo(ROW_HEIGHT + 1_999 * ROW_HEIGHT);

    const values = dataCells().map((cell) => cell.getAttribute('title'));
    expect(values).toContain('r1999c0');
  });

  test('reaches the last retained row when a row of the file has no text', async () => {
    // The first data row holds nothing but delimiters, so it is shorter than
    // the rows below it.
    await render(buildCsvWithAnEmptyRow(2_000, 4));

    await scrollTo(ROW_HEIGHT + 1_999 * ROW_HEIGHT);

    const values = dataCells().map((cell) => cell.getAttribute('title'));
    expect(values).toContain('r1999c0');
  });

  test('gives a row without text the height of a row with text', async () => {
    await render(buildCsvWithAnEmptyRow(4, 3));

    const rows = Array.from(host.querySelectorAll<HTMLElement>('tbody tr'))
      .filter((row) => row.querySelector('td[title]'));
    expect(rows.length).toBe(4);
    for (const row of rows) {
      expect(row.style.height).toBe(`${ROW_HEIGHT}px`);
    }
  });

  test('keeps the height of the header row when the header cells are empty', async () => {
    // The first columns of the file have no header, so the window opens over
    // header cells that hold nothing. A header row that takes its height from
    // the cells in view collapses to the padding and the border, and the
    // content below it jumps while the window moves.
    await render(buildCsvWithEmptyHeaders(20, 50, 25));

    // The header row is given the height of a row, so the cells in view
    // cannot change it.
    expect(host.querySelector<HTMLElement>('thead tr')?.style.height).toBe(`${ROW_HEIGHT}px`);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);

    // The window moves onto the columns that have a header.
    await scrollTo(0, 1200);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);

    // And back onto the ones that have none.
    await scrollTo(0, 0);
    expect(headerRowHeight()).toBe(ROW_HEIGHT);
    expect(stickyHeaderHeight()).toBe(ROW_HEIGHT);
  });

  test('gives the header cell the box of a cell of the body', async () => {
    await render(buildCsv(4, 3));

    // The header row is given the height of a row, and that height is
    // measured from a cell of the body, so the header cell has to hold the
    // same box.
    expect(boxClasses(host.querySelector('th[scope="col"]')))
      .toEqual(boxClasses(host.querySelector('td[title]')));
  });

  test('mounts the same rows for a file whose header cells are empty', async () => {
    await render(buildCsv(200, 50));
    const withHeaders = host.querySelectorAll('tbody tr').length;
    await render(buildCsvWithEmptyHeaders(200, 50, 25));
    const withEmptyHeaders = host.querySelectorAll('tbody tr').length;

    // The sticky header covers one row, whichever header cells are in view,
    // so the window holds the same rows either way.
    expect(withEmptyHeaders).toBe(withHeaders);
  });

  test('writes the height of a spacer row on the row', async () => {
    await render(buildCsv(2_100, 50));
    await scrollTo(ROW_HEIGHT * 100);

    const spacers = Array.from(host.querySelectorAll<HTMLElement>('tbody tr'))
      .filter((row) => !row.querySelector('td[title]'));
    expect(spacers.length).toBeGreaterThan(0);
    for (const spacer of spacers) {
      // The spacer carries the height of the rows it stands for.
      const asked = Number.parseFloat(spacer.style.height);
      expect(asked).toBeGreaterThan(0);
      expect(asked % ROW_HEIGHT).toBe(0);
      // The height is on the row: a cell's own padding would make the cell
      // taller than the height it asks for, and the rows would sit lower
      // than the model says.
      expect(spacer.firstElementChild?.getAttribute('style') ?? '').not.toContain('height');
    }
  });

  test('names the row the scroll position is on when a row has no text', async () => {
    await render(buildCsvWithAnEmptyRow(200, 4));

    // Ten rows down, with the scroll position inside the eleventh.
    await scrollTo(ROW_HEIGHT * 10 + 13);

    expect(mountedRowNames()).toContain('r10');
  });

  test('shows the empty state for a file without rows', async () => {
    await render('');

    expect(host.textContent).toContain('This file has no rows.');
    expect(host.querySelector('table')).toBeNull();
  });

  test('opens a file the same way after a file without rows', async () => {
    // A file without rows has no table to measure, so the preview has to be
    // measured again for the file that comes after it.
    await render('');
    await render(buildCsv(20, 8));

    // The whole table fits into the panel, so every column of it and every
    // one of its rows has to be in the document.
    expect(host.querySelectorAll('th[scope="col"]').length).toBe(8);
    expect(dataCells().length).toBe(19 * 8);
  });

  test('notices a font change after a file without rows', async () => {
    await render('');
    await render(buildCsv(20, 50));
    const before = mountedColumns().length;

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });

    expect(mountedColumns().length).toBeLessThan(before);
  });

  test('notices a font change through the probe it watches', async () => {
    // The observer of the browser reports the content box of the element it
    // watches, and an inline box has no content box of its own: the browser
    // reports an empty one for it and never reports a resize for it. The
    // preview watches the probe's text, so that text has to be a box of its
    // own for a change of the font to reach the measurement.
    globalThis.ResizeObserver = ContentBoxResizeObserver;
    await render(buildCsv(20, 50));
    const before = mountedColumns().length;
    expect(before).toBeGreaterThan(0);

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of ContentBoxResizeObserver.instances) observer.fire();
    });

    expect(mountedColumns().length).toBeLessThan(before);
  });

  test('computes the window of the file that is open when the table is scrolled', async () => {
    // The window is computed from the model of the commit that is on
    // screen, so a scroll event asks for the rows of the file that is open
    // now.
    await render(buildCsv(100, 50));
    await scrollTo(ROW_HEIGHT * 50);
    expect(mountedRowNames()).toContain('r50');

    // A new file, with more rows and fewer columns.
    await render(buildCsv(500, 4));
    await scrollTo(ROW_HEIGHT * 400);

    // The scroll lands on a row of the file that is open now, not on a row
    // of the file before it.
    expect(mountedRowNames()).toContain('r400');
  });

  test('measures a file that has a header but no rows', async () => {
    // The measuring probe is in the document as long as the file has
    // columns, so a file with a header and no rows is measured like any
    // other file.
    const header = Array.from({ length: 50 }, (_, column) => `h${column}`).join(',');
    await render(header);
    const before = host.querySelectorAll('th[scope="col"]').length;
    expect(before).toBeGreaterThan(0);

    // The font changes, so a character takes more room and fewer columns
    // fit into the panel.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await act(async () => {
      for (const observer of FakeResizeObserver.instances) observer.fire();
    });

    expect(host.querySelectorAll('th[scope="col"]').length).toBeLessThan(before);
  });

  test('does not walk over the cells of the file again when the panel is resized', async () => {
    await render(buildCsv(200, 50));
    const afterOpen = cellWalks;
    // The walk has to have happened, or the count below says nothing.
    expect(afterOpen).toBeGreaterThan(0);

    // The panel grows: the room it has changes, the widths the file asks for
    // do not, so the cells of the file are not walked over again.
    await resize(VIEWPORT_WIDTH + 240);

    expect(cellWalks).toBe(afterOpen);
  });

  test('walks over the cells of the file again when the font changes', async () => {
    await render(buildCsv(200, 50));
    const afterOpen = cellWalks;
    expect(afterOpen).toBeGreaterThan(0);

    // The font changes, so a character takes more room and the widths the
    // file asks for are measured again.
    probeTextWidth = PROBE_CHARACTER_COUNT * MEASURED_ADVANCE * 4;
    await resize(VIEWPORT_WIDTH);

    expect(cellWalks).toBeGreaterThan(afterOpen);
  });

  test('walks over the cells of the file again when the file changes', async () => {
    await render(buildCsv(20, 4));
    const afterOpen = cellWalks;
    expect(afterOpen).toBeGreaterThan(0);

    await render(buildCsv(20, 8));

    expect(cellWalks).toBeGreaterThan(afterOpen);
  });

  test('measures a file whose dropped rows hold wide characters as a latin file', async () => {
    // The flag is read over the cells the measurement walks, and a dropped
    // row is never measured, so the wide characters of a dropped row cannot
    // change a width.
    const lines = buildCsv(2_001, 4).split('\n');
    lines.push('名前,wide,wide,wide');
    await render(lines.join('\n'));

    expect(lastAsciiOnly).toBe(true);
  });

  test('measures a file whose kept rows hold wide characters the wide way', async () => {
    const lines = buildCsv(10, 4).split('\n');
    lines[3] = '名前,wide,wide,wide';
    await render(lines.join('\n'));

    expect(lastAsciiOnly).toBe(false);
  });

  test('sizes a column to the value it holds', async () => {
    await render(`h\n${'x'.repeat(65)}`);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('65ch');

    await render(`h\n${'x'.repeat(66)}`);
    expect(host.querySelector('col')?.getAttribute('style')).toContain('66ch');
  });

  test('writes the width of a column from the measurement of the cell', async () => {
    await render(buildCsv(4, 3));

    // The padding and the border the preview measured are the ones the width
    // of the column is written with.
    const columns = Array.from(host.querySelectorAll('col'));
    expect(columns).toHaveLength(3);
    expect(columns[0]?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
    // The last column keeps its missing border.
    expect(columns[2]?.getAttribute('style')).toContain('calc(4ch + 16px)');
    expect(columns[2]?.getAttribute('style')).not.toContain('+ 1px');
  });

  test('writes the width of the table from the same measurement', async () => {
    await render(buildCsv(4, 3));

    // The table is as wide as its columns together: twelve characters, three
    // paddings and the two borders between the columns.
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 2px)');
  });

  test('moves the width of the columns when the padding of the cell changes', async () => {
    await render(buildCsv(4, 3));
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');

    // The padding of the cell changes, and the preview measures it again.
    cellPadding = 12;
    await resize(VIEWPORT_WIDTH);

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 24px + 1px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 72px + 2px)');
  });

  test('moves the width of the columns when the border of the cell changes', async () => {
    await render(buildCsv(4, 3));
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');

    // The border of the cell changes, and the preview measures it again.
    cellBorder = 2;
    await resize(VIEWPORT_WIDTH);

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 2px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 4px)');
  });

  test('the measuring probe carries the padding and the border of a cell', async () => {
    await render(buildCsv(4, 3));

    // The probe is read for the padding and the border of a cell, so the two
    // have to carry the same classes.
    const probe = host.querySelector('span[aria-hidden="true"]');
    const cell = host.querySelector('td[title]');
    expect(chromeClasses(probe)).not.toEqual([]);
    expect(chromeClasses(probe)).toEqual(chromeClasses(cell));
  });

  test('cuts a value one character over the room of the cell short', async () => {
    await render(`h\n${'x'.repeat(67)}`);

    // The column holds the 66 characters that fit, and the cell cuts the
    // value short.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('66ch');
  });

  test('mounts the columns the viewer can see after the document turns right to left', async () => {
    await render(buildUniformCsv(50));

    // The window starts at the first column of a left-to-right document.
    expect(mountedColumns()).toEqual(columnsFrom(0, 20));

    // A right-to-left document is scrolled from the other end, and the
    // application sets the direction on the root element.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      scrollLeft = -200;
      const scroller = windowInstance.document.querySelector('.overflow-auto');
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The columns on screen are the ones the right-to-left window holds.
    expect(mountedColumns()).toEqual(columnsFrom(2, 24));
  });

  test('mounts the columns the viewer can see at the far end of a wide right-to-left table', async () => {
    const columns = 500;
    await render(buildUniformCsv(columns));

    // A right-to-left table is scrolled from its other end, and the
    // application sets the direction on the root element.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      scrollLeft = -(columns * COLUMN_WIDTH - VIEWPORT_WIDTH);
      const scroller = windowInstance.document.querySelector('.overflow-auto');
      scroller?.dispatchEvent(new windowInstance.Event('scroll', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The far end of a right-to-left table shows the last columns of the
    // file, and every one of them has to be in the document.
    expect(mountedColumns()).toEqual(columnsFrom(columns - 20, columns));
  });

  test('gives the spacer cells the border of a cell of the table', async () => {
    await render(buildCsv(20, 50));
    // The table is wide, so the window has a spacer on both sides of it.
    await scrollTo(0, 1000);

    const spacers = columnSpacers();
    expect(spacers).toHaveLength(2);
    const [leading, trailing] = spacers;
    // The rule under the row runs across the spacer, and the spacer before
    // the window is an interior boundary and keeps the border on its inline
    // end.
    expect(borderClasses(leading)).toEqual(['border-b', 'border-border/30', 'border-e']);
    // The spacer at the end of the file is the table's own last column and
    // keeps the missing border.
    expect(borderClasses(trailing)).toEqual(['border-b', 'border-border/30']);
  });

  test('gives the spacer cells of the header the border of a header cell', async () => {
    await render(buildCsv(20, 50));
    await scrollTo(0, 1000);

    const spacers = Array.from(host.querySelectorAll('thead th[colspan]'));
    expect(spacers).toHaveLength(2);
    const [leading, trailing] = spacers;
    expect(borderClasses(leading)).toEqual(['border-b', 'border-border/40', 'border-e']);
    expect(borderClasses(trailing)).toEqual(['border-b', 'border-border/40']);
  });

  test('mounts the columns of the new file and not the ones of the file before it', async () => {
    // The window of the file before names more columns than the file that is
    // open now has, so the first commit of the new file has to hold the new
    // file's own columns.
    const commits: { headers: number; emptyCells: number }[] = [];
    const record = () => {
      commits.push({
        headers: host.querySelectorAll('th[scope="col"]').length,
        emptyCells: Array.from(host.querySelectorAll('td[title]'))
          .filter((cell) => cell.getAttribute('title') === '').length,
      });
    };
    const mount = async (content: string) => {
      await act(async () => {
        root.render(
          <I18nProvider>
            <CommitWatcher onCommit={record}>
              <TableArtifact path="/repo/data.csv" content={content} sizeBytes={null} />
            </CommitWatcher>
          </I18nProvider>,
        );
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    };

    await mount(buildCsv(20, 50));
    commits.length = 0;
    await mount(buildCsv(20, 4));

    // Every commit of the new file holds its own columns, and no cell of a
    // column the new file does not have.
    expect(commits.length).toBeGreaterThan(0);
    for (const commit of commits) {
      expect(commit.headers).toBeLessThanOrEqual(4);
      expect(commit.emptyCells).toBe(0);
    }
  });

  test('counts the border of a cell when the runtime does not resolve the logical side', async () => {
    // A runtime that does not resolve the logical border counts no border
    // at all, and the error grows by a pixel with every column, so the
    // columns in view stop being the ones on screen.
    logicalBorderResolves = false;
    await render(buildCsv(4, 3));

    // The border is read on the side the direction of the document puts it.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
    expect(host.querySelector('table')?.getAttribute('style')).toContain('calc(12ch + 48px + 2px)');
  });

  test('counts the border of a cell on the left in a right-to-left document', async () => {
    logicalBorderResolves = false;
    await render(buildCsv(4, 3));

    // The document turns right to left, so the border of a cell is on its
    // left edge.
    await act(async () => {
      windowInstance.document.documentElement.setAttribute('dir', 'rtl');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(host.querySelector('col')?.getAttribute('style')).toContain('calc(4ch + 16px + 1px)');
  });

  test('stripes the rows by their index and not by their place in the document', async () => {
    await render(buildCsv(200, 4));

    // The window is moved over a row with an odd index, so the first row in
    // the document is an odd one.
    await scrollTo(ROW_HEIGHT * 11);

    const rows = mountedRows();
    expect(rows.length).toBeGreaterThan(1);
    // A stripe that followed the place of the row in the document would be
    // the wrong one for the first row in it.
    expect(rows[0]?.index % 2).toBe(1);
    for (const row of rows) {
      expect(stripeOf(row.element)).toBe(row.index % 2 === 0 ? 'even' : 'odd');
    }
  });

  test('keeps the border on the inline end of the columns before the last one of the file', async () => {
    await render(buildCsv(20, 50));

    // The window is in the middle of the file, so the last column in the
    // document is not the last column of the file.
    await scrollTo(0, 1000);

    const cells = dataCells();
    expect(cells.length).toBeGreaterThan(0);
    for (const cell of cells) {
      expect(keepsEndBorder(cell)).toBe(true);
    }
    for (const header of Array.from(host.querySelectorAll('th[scope="col"]'))) {
      expect(keepsEndBorder(header)).toBe(true);
    }
  });

  test('gives the last column of the file its missing border', async () => {
    await render(buildCsv(20, 4));

    const cells = dataCells();
    const lastColumn = cells.filter((cell) => cell.getAttribute('title')?.endsWith('c3'));
    expect(lastColumn.length).toBeGreaterThan(0);
    for (const cell of lastColumn) {
      expect(keepsEndBorder(cell)).toBe(false);
    }
    for (const cell of cells.filter((cell) => !cell.getAttribute('title')?.endsWith('c3'))) {
      expect(keepsEndBorder(cell)).toBe(true);
    }

    // The header of the last column of the file keeps the missing border as
    // well.
    const headers = Array.from(host.querySelectorAll('th[scope="col"]'));
    expect(headers).toHaveLength(4);
    expect(keepsEndBorder(headers[3])).toBe(false);
    expect(keepsEndBorder(headers[0])).toBe(true);
  });

  test('counts a character the browser lays out wider at the width the browser gives it', async () => {
    // A character the monospace font does not cover falls back to another
    // font, and that font can lay the character out wider. The preview
    // measures the character and counts the value at the width it takes
    // there, so the value is not cut short.
    characterAdvances.set('Ω', 9);
    await render(`h\n${'Ω'.repeat(10)}`);

    // Ten characters of 9 px take 90 px, which is twelve cells of 7.5 px.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('12ch');
  });

  test('keeps the counted width of a character the browser lays out narrower', async () => {
    // A character that takes less room than the monospace font does keeps
    // the cell the count gives it, so the column is not padded with room
    // the text does not need.
    characterAdvances.set('Я', 7.19);
    await render(`h\n${'Я'.repeat(10)}`);

    // Ten characters still take ten cells, and not less.
    expect(host.querySelector('col')?.getAttribute('style')).toContain('10ch');
  });
});
