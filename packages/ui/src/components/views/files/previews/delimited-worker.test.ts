import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';

import type { DelimitedTable } from './delimitedText';
import type { DelimitedWorkerRequest, DelimitedWorkerResponse } from './delimited-worker-protocol';

// Bun cannot load Vite's `?worker&url` import that the client of the worker
// makes. The URL is only read when a worker is made, and the worker of this
// test is a double that never loads anything.
mock.module('./delimited-text.worker.ts?worker&url', () => ({
  default: 'blob:test-delimited-worker',
}));

const {
  countDelimitedColumnCellsInWorker,
  parseDelimitedTextInWorker,
  resetDelimitedWorkerClientForTests,
} = await import('./delimited-worker');

/** The answer the client reads from a worker. */
type WorkerMessage = (event: { data: DelimitedWorkerResponse }) => void;

/**
 * A worker that answers what the test tells it to answer.
 *
 * The client uses only a few members of a worker: it posts a request, it
 * reads the answer, and it terminates the worker when it gives up on it.
 */
class FakeWorker {
  /** Every worker the client has made. */
  static instances: FakeWorker[] = [];
  /** Whether every worker refuses the requests it is given. */
  static refuses = false;
  /** The requests the client sent to this worker. */
  readonly sent: DelimitedWorkerRequest[] = [];
  onmessage: WorkerMessage | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  /** Whether the client gave up on this worker. */
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: DelimitedWorkerRequest): void {
    if (FakeWorker.refuses) throw new Error('The worker does not take the request');
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  /** Answer the request the client is waiting for. */
  answer(response: DelimitedWorkerResponse): void {
    this.onmessage?.({ data: response });
  }
}

/** A table the worker hands over, the shape the parser produces. */
const TABLE: DelimitedTable = {
  header: ['a', 'b'],
  rows: [{ start: 4, end: 7 }],
  totalRows: 1,
  columnCount: 2,
  truncated: false,
  columnCells: [1, 1],
  codePoints: [],
};

/** The worker the client made, once it has made it. */
const currentWorker = async (): Promise<FakeWorker> => {
  await new Promise((resolve) => setTimeout(resolve, 0));
  const worker = FakeWorker.instances[0];
  if (!worker) throw new Error('The client did not make a worker');
  return worker;
};

describe('the client of the delimited worker', () => {
  let originalWorker: unknown;
  let originalWindow: unknown;

  beforeEach(() => {
    originalWorker = globalThis.Worker;
    originalWindow = globalThis.window;
    FakeWorker.instances = [];
    FakeWorker.refuses = false;
    // The client makes a worker in a browser, and this test is not one.
    Object.assign(globalThis, { Worker: FakeWorker, window: globalThis });
    resetDelimitedWorkerClientForTests();
  });

  afterEach(() => {
    resetDelimitedWorkerClientForTests();
    Object.assign(globalThis, { Worker: originalWorker, window: originalWindow });
  });

  test('parses a file in the worker', async () => {
    const pending = parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 1_000);
    const worker = await currentWorker();

    expect(worker.sent).toHaveLength(1);
    const request = worker.sent[0];
    if (!request || request.type !== 'parse') throw new Error('The request is not a parse');
    expect(request.content).toBe('a,b\n1,2');
    expect(request.delimiter).toBe(',');
    expect(request.rowCap).toBe(100);

    worker.answer({ type: 'parsed', id: request.id, table: TABLE });
    const parsed = await pending;
    expect(parsed?.table).toBe(TABLE);
    // The parse carries the id a count request names.
    expect(parsed?.id).toBe(request.id);
  });

  test('counts the widths of the columns of a parse in the worker', async () => {
    const pending = parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 1_000);
    const worker = await currentWorker();
    const parseRequest = worker.sent[0];
    if (!parseRequest || parseRequest.type !== 'parse') throw new Error('The request is not a parse');
    worker.answer({ type: 'parsed', id: parseRequest.id, table: TABLE });
    const parsed = await pending;
    if (!parsed) throw new Error('The worker did not answer the parse');

    const widths = new Map([[0x3a9, 1.5]]);
    const counted = countDelimitedColumnCellsInWorker(parsed.id, widths, 1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(worker.sent).toHaveLength(2);
    const countRequest = worker.sent[1];
    if (!countRequest || countRequest.type !== 'count') throw new Error('The request is not a count');
    // The count names the parse it belongs to, so the text of the file does
    // not have to be sent a second time.
    expect(countRequest.parseId).toBe(parsed.id);
    expect(countRequest.characterWidths.get(0x3a9)).toBe(1.5);

    worker.answer({ type: 'counted', id: countRequest.id, cells: [3, 2] });
    expect(await counted).toEqual([3, 2]);
  });

  test('fails a request when the runtime has no worker', async () => {
    Reflect.deleteProperty(globalThis, 'Worker');

    expect(await parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 1_000)).toBeNull();
    expect(FakeWorker.instances).toHaveLength(0);
  });

  test('fails a request when the worker crashes', async () => {
    const pending = parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 1_000);
    const worker = await currentWorker();

    worker.onerror?.();

    expect(await pending).toBeNull();
  });

  test('gives up on a worker that does not answer in time', async () => {
    const pending = parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 50);
    const worker = await currentWorker();

    // The worker never answers, so the request runs out of its budget.
    expect(await pending).toBeNull();
    // The worker is given up on, so it is terminated and its memory is freed.
    expect(worker.terminated).toBe(true);
  });

  test('fails a request the worker does not take', async () => {
    // The worker throws when the request is posted, so the request cannot be
    // made and the promise the caller waits for has to fail.
    FakeWorker.refuses = true;
    const pending = parseDelimitedTextInWorker('a,b\n1,2', ',', 100, 1_000);
    const worker = await currentWorker();

    expect(await pending).toBeNull();
    // The worker is given up on, so it is terminated and its memory is
    // freed, the way it is when it crashes and when it does not answer in
    // time.
    expect(worker.terminated).toBe(true);
  });
});
