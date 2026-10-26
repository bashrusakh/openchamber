/**
 * The export's own writing.
 *
 * The export reads every session from the directory it runs in. A descendant
 * that runs in another directory lives in another session store, so the
 * root's directory would never find its records — and the document would
 * say the transcript could not be loaded.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import { z } from 'zod';
import type { SessionMessageAssistant } from '@opencode/client';
import type { Session } from '@/lib/opencode/model';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { ExportFormat, SessionMessageRecord } from '@/lib/exportSession';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator,
  Node: browser.Node, Element: browser.Element, HTMLElement: browser.HTMLElement,
  HTMLInputElement: browser.HTMLInputElement, HTMLButtonElement: browser.HTMLButtonElement,
  Event: browser.Event, MouseEvent: browser.MouseEvent, PointerEvent: browser.PointerEvent,
  KeyboardEvent: browser.KeyboardEvent, FocusEvent: browser.FocusEvent,
  localStorage: browser.localStorage,
  getComputedStyle: browser.getComputedStyle.bind(browser),
  requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser),
  IS_REACT_ACT_ENVIRONMENT: true,
});

let savedDocumentCount = 0;

/** The warnings the export showed the person who asked for it. */
const toastWarnings: string[] = [];

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/ui', () => ({
  toast: {
    error: () => undefined,
    success: () => undefined,
    warning: (message: string) => { toastWarnings.push(message); },
  },
}));

/** The records every directory holds, keyed by the session they belong to. */
const recordsByDirectory = new Map<string, Map<string, SessionMessageRecord[]>>();

/** The reads the export made, in the order it made them. */
const recordReads: Array<{ directory: string; sessionID: string }> = [];
/** What one session's read established, the way the loader reports it. */
type ExportRecords = { records: SessionMessageRecord[]; inboxUnavailable?: boolean };
let loadRecordsOverride: ((target: { directory: string; sessionID: string }) => Promise<ExportRecords | null>) | null = null;
let runtimeResponse: ((request: Request) => Promise<Response>) | null = null;

const runtimeUrlResolver = {
  api: () => 'http://runtime.test/api',
  sse: () => 'http://runtime.test/api/event',
  websocket: () => 'ws://runtime.test/api/event',
  authenticatedAsset: (path: string) => path,
};
mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: () => runtimeUrlResolver,
  createRuntimeUrlResolver: () => runtimeUrlResolver,
  configureRuntimeUrlResolver: () => runtimeUrlResolver,
  setRuntimeUrlResolver: () => undefined,
}));
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request
      ? input
      : new Request(input instanceof URL ? input : new URL(input, 'http://runtime.test'), init);
    if (runtimeResponse) return runtimeResponse(request);
    const path = new URL(request.url).pathname;
    const body = path.includes('/session')
      ? { data: [], cursor: {} }
      : path.endsWith('/location')
        ? { directory: '/repo', project: { id: 'proj', directory: '/repo', canonical: '/repo' } }
        : {};
    return new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  },
}));

mock.module('@/sync/use-sync', () => ({
  useSessionMessageRecordsForExport: () => async ({ directory, sessionID }: { directory: string; sessionID: string }) => {
    recordReads.push({ directory, sessionID });
    if (loadRecordsOverride) return loadRecordsOverride({ directory, sessionID });
    const records = recordsByDirectory.get(directory)?.get(sessionID);
    return records ? { records } : null;
  },
}));

/** The document the export wrote. */
let writeDocument: (content: string) => void = () => undefined;

const exportSession = await import('@/lib/exportSession');
mock.module('@/lib/exportSession', () => ({
  ...exportSession,
  saveAsMarkdownDesktop: async (content: string) => {
    savedDocumentCount += 1;
    writeDocument(content);
    return '/tmp/export.md';
  },
}));

const globalSessionsStore = await import('@/stores/useGlobalSessionsStore');

/**
 * The app's own global session load, as the export sees it.
 *
 * The list arrives in pages, and the export waits for the whole list before
 * it claims a tree. The test decides when the list arrives and what it
 * holds.
 */
let listLoads = 0;
let listLoadGate: Promise<void> | null = null;
let listLoadOutcome: { sessions: Session[]; complete: boolean } | null = null;

mock.module('@/stores/useGlobalSessionsStore', () => ({
  ...globalSessionsStore,
  ensureGlobalSessionsLoaded: async () => {
    listLoads += 1;
    if (listLoadGate) await listLoadGate;
    const outcome = listLoadOutcome;
    const activeSessions = outcome?.sessions ?? [];
    const archivedSessions: Session[] = [];
    globalSessionsStore.useGlobalSessionsStore.setState({
      activeSessions,
      archivedSessions,
      sessionsByDirectory: new Map(),
      entityById: new Map(),
      structure: {
        activeSessionIds: [],
        activeRootIds: [],
        activeChildrenByParentId: new Map(),
        activeIdsByDirectory: new Map(),
      },
      hasLoaded: outcome?.complete ?? false,
      status: outcome?.complete ? 'ready' : 'error',
    });
    return { activeSessions, archivedSessions };
  },
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionExport } = await import('./useSessionExport');
const { opencodeClient } = await import('@/lib/opencode/client');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader } = await import('@/sync/session-message-loader');

beforeEach(() => {
  listLoads = 0;
  listLoadGate = null;
  listLoadOutcome = null;
  loadRecordsOverride = null;
  toastWarnings.length = 0;
});

afterAll(() => {
  browser.close();
});

/** A promise the test opens by hand, so a step can wait for the test's cue. */
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const session = (id: string, overrides: Partial<Session> = {}): Session => ({
  id,
  projectID: 'proj_1',
  directory: '/repo',
  title: id,
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0, updated: 0 },
  ...overrides,
});

const textRecord = (sessionID: string, id: string, content: string, created: number): SessionMessageRecord => ({
  info: { id, sessionID, role: 'user', time: { created } },
  parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: content }],
});

const answerRecord = (sessionID: string, id: string, content: string, created: number): SessionMessageRecord => ({
  info: {
    id, sessionID, role: 'assistant', agent: 'reviewer',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created, completed: created + 100 },
  },
  parts: [{ id: `${id}-text`, sessionID, messageID: id, type: 'text', text: content }],
});

/** The call that started a child session. */
const delegationRecord = (
  sessionID: string,
  id: string,
  childSessionID: string,
  created: number,
): SessionMessageRecord => ({
  info: {
    id, sessionID, role: 'assistant', agent: 'build',
    providerID: 'anthropic', modelID: 'claude-opus-4-1', time: { created, completed: created + 100 },
  },
  parts: [{
    id: `${id}-subagent`, sessionID, messageID: id, type: 'tool', callID: `${id}-call`, tool: 'subagent',
    state: {
      status: 'completed',
      input: { description: 'Review the change', prompt: 'Review the whole change', agent: 'reviewer' },
      output: 'The review found blocking defects.',
      metadata: { sessionID: childSessionID },
      time: { start: created, end: created + 100 },
    },
  }],
});

const rootRecords: SessionMessageRecord[] = [
  textRecord('ses_root', 'u1', 'Do the work', 1000),
  delegationRecord('ses_root', 'a1', 'ses_child', 2000),
];

const childRecords: SessionMessageRecord[] = [
  textRecord('ses_child', 'cu1', 'Review the change', 2100),
  answerRecord('ses_child', 'ca2', 'Verdict: changes required.', 2500),
];

/** The child's records, with the call that started the grandchild. */
const childRecordsWithGrandchild: SessionMessageRecord[] = [
  textRecord('ses_child', 'cu1', 'Review the change', 2100),
  delegationRecord('ses_child', 'ca1', 'ses_grand', 2200),
  answerRecord('ses_child', 'ca2', 'Verdict: changes required.', 2500),
];

const grandRecords: SessionMessageRecord[] = [
  answerRecord('ses_grand', 'ga1', 'Deeper work', 2300),
];

/** Puts the sessions into the store, the way the app holds them. */
const setSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({
    activeSessions: [],
    archivedSessions: [],
    sessionsByDirectory: new Map(),
    entityById: new Map(),
    structure: {
      activeSessionIds: [],
      activeRootIds: [],
      activeChildrenByParentId: new Map(),
      activeIdsByDirectory: new Map(),
    },
    hasLoaded: true,
    status: 'ready',
  });
  useGlobalSessionsStore.getState().upsertSessions(sessions);
};

/**
 * Puts the sessions into the store while the list is still being read.
 *
 * The list arrives in pages, and the export cannot claim a tree before the
 * whole list is there.
 */
const setPartialSessions = (sessions: Session[]): void => {
  useGlobalSessionsStore.setState({
    activeSessions: [],
    archivedSessions: [],
    sessionsByDirectory: new Map(),
    entityById: new Map(),
    structure: {
      activeSessionIds: [],
      activeRootIds: [],
      activeChildrenByParentId: new Map(),
      activeIdsByDirectory: new Map(),
    },
    hasLoaded: false,
    status: 'loading',
  });
  useGlobalSessionsStore.getState().upsertSessions(sessions);
};

/**
 * Puts the records into the directories they live in.
 *
 * A session store holds the records of the sessions that run in its own
 * directory, so a record read from the wrong directory finds nothing.
 */
const setRecords = (entries: Array<[directory: string, sessionID: string, records: SessionMessageRecord[]]>): void => {
  recordsByDirectory.clear();
  recordReads.length = 0;
  for (const [directory, sessionID, records] of entries) {
    const bySession = recordsByDirectory.get(directory) ?? new Map<string, SessionMessageRecord[]>();
    bySession.set(sessionID, records);
    recordsByDirectory.set(directory, bySession);
  }
};

/**
 * Opens the export dialog for a session and confirms it.
 *
 * The dialog is opened and confirmed, the way a reader does it, so the test
 * reads what the export writes. The export itself keeps running after the
 * confirmation, so the caller gets the document it writes and the handle
 * that closes the dialog.
 */
const openAndConfirmExport = async (
  target: { sessionID: string; directory: string },
  options: { format?: ExportFormat; detailed?: boolean; includeSubagents?: boolean } = {},
): Promise<{ written: Promise<string>; stop: () => Promise<void> }> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let open: (next: { sessionID: string; title: string; directory: string }) => void = () => undefined;
  const written = new Promise<string>((resolve) => { writeDocument = resolve; });

  const ExportApi = () => {
    const api = useSessionExport();
    open = api.openExport;
    return <>{api.dialog}</>;
  };

  const Harness = () => (
    <I18nProvider>
      <ExportApi />
    </I18nProvider>
  );

  await act(async () => {
    root.render(<Harness />);
  });

  await act(async () => {
    open({ sessionID: target.sessionID, title: 'Root', directory: target.directory });
  });

  const format = options.format;
  if (format && format !== 'markdown') {
    await act(async () => {
      container.querySelector<HTMLElement>(`button[aria-label="${format.toUpperCase()}"]`)?.click();
    });
  }
  if (options.detailed) {
    await act(async () => {
      container.querySelector<HTMLElement>('button[aria-label="Full details"]')?.click();
    });
  }
  if (options.includeSubagents === false) {
    await act(async () => {
      const coverage = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
      expect(coverage).toBeTruthy();
      coverage?.click();
    });
  }
  await act(async () => {
    const confirm = [...container.querySelectorAll<HTMLElement>('button')].find((candidate) => (
      candidate.textContent?.trim() === 'Export'
    ));
    expect(confirm).toBeTruthy();
    confirm?.click();
  });

  return {
    written,
    stop: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
};

/**
 * Exports a session and hands back the document it wrote.
 */
const exportSessionTo = async (
  target: { sessionID: string; directory: string },
  format: ExportFormat = 'markdown',
  detailed = false,
  noDocumentExpected = false,
  actionSettled?: Promise<void>,
): Promise<string> => {
  if (noDocumentExpected) {
    const { stop } = await openAndConfirmExport(target, { format, detailed });
    await actionSettled;
    await new Promise((resolve) => setTimeout(resolve, 0));
    await stop();
    return '';
  }

  const { written, stop } = await openAndConfirmExport(target, { format, detailed });
  const outputDocument = await written;
  await stop();
  return outputDocument;
};

const wireUser = (id: string, created: number, text: string) => ({ id, type: 'user', time: { created }, text, files: [] });
type WireAssistantContent = SessionMessageAssistant['content'][number];
type WireToolState = Extract<WireAssistantContent, { type: 'tool' }>['state'];
const shellAssistant = (id: string, created: number, content: WireAssistantContent[]) => ({
  id, type: 'assistant', time: { created, completed: created + 100 }, agent: 'build',
  model: { id: 'model', providerID: 'provider' }, content,
});
const wireTool = (id: string, name: string, created: number, state: WireToolState): Extract<WireAssistantContent, { type: 'tool' }> => ({
  type: 'tool', id, name, time: { created, ran: created + 1, completed: created + 2 }, state,
});

test('the user export action serializes real shelled history through the SDK in all formats', async () => {
  savedDocumentCount = 0;
  const rootToolID = 'call_root_read';
  const childToolID = 'call_child_bash';
  const rootRecordsWire = [
    wireUser('root_user', 1000, 'Read the result'),
    shellAssistant('root_answer', 2000, [
      { type: 'text', text: 'root before' },
      wireTool(rootToolID, 'read', 2100, {
        status: 'completed', input: { filePath: 'result.txt' }, content: [{ type: 'text', text: '' }],
        metadata: { openchamberContentShell: { chars: 13 } },
      }),
      { type: 'text', text: 'root after' },
    ]),
    shellAssistant('root_delegate', 3000, [wireTool('call_delegate', 'subagent', 3001, {
      status: 'completed', input: { description: 'Child work', agent: 'reviewer' },
      content: [{ type: 'text', text: 'started' }], metadata: { sessionID: 'ses_child' },
    })]),
  ];
  const childRecordsWire = [
    wireUser('child_user', 3100, 'Child prompt'),
    shellAssistant('child_answer', 3200, [
      { type: 'text', text: 'child before' },
      wireTool(childToolID, 'bash', 3300, {
        status: 'completed', input: { command: 'cat result.txt' }, content: [{ type: 'text', text: '' }],
        metadata: { openchamberContentShell: { chars: 12 } },
      }),
      { type: 'text', text: 'child after' },
    ]),
  ];
  const fullRecords = new Map([
    ['root_answer', shellAssistant('root_answer', 2000, [
      { type: 'text', text: 'root before' },
      wireTool(rootToolID, 'read', 2100, {
        status: 'completed', input: { filePath: 'result.txt' },
        content: [{ type: 'text', text: 'complete root output' }, { type: 'file', uri: 'file:///result.txt', mime: 'text/plain', name: 'result.txt' }], metadata: {},
      }),
      { type: 'text', text: 'root after' },
    ])],
    ['child_answer', shellAssistant('child_answer', 3200, [
      { type: 'text', text: 'child before' },
      wireTool(childToolID, 'bash', 3300, {
        status: 'completed', input: { command: 'cat result.txt' }, content: [{ type: 'text', text: 'complete child output' }], metadata: {},
      }),
      { type: 'text', text: 'child after' },
    ])],
  ]);
  const requests: Request[] = [];
  let childPageFailure = false;
  let rootMessageFailure = false;
  let finishRootFailureRead: () => void = () => {};
  const rootFailureRead = new Promise<void>((resolve) => { finishRootFailureRead = resolve; });
  runtimeResponse = async (request) => {
    requests.push(request);
    const url = new URL(request.url);
    if (url.pathname === '/api/version') return new Response(JSON.stringify({ compatibility: { capabilities: ['api.message-part-shells.v1'] } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/location') return new Response(JSON.stringify({ directory: '/repo', project: { id: 'proj', directory: '/repo', canonical: '/repo' } }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname === '/api/session') return new Response(JSON.stringify({ data: [], cursor: {} }), { headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/inbox')) return new Response(JSON.stringify({ data: [] }), { headers: { 'content-type': 'application/json' } });
    const sessionID = url.pathname.includes('/ses_child/') ? 'ses_child' : 'ses_root';
    if (url.pathname.endsWith('/message')) {
      if (sessionID === 'ses_child' && childPageFailure) return new Response(JSON.stringify({ message: 'child history unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } });
      const wireRecords = sessionID === 'ses_root' ? rootRecordsWire : childRecordsWire;
      if (!request.headers.has('x-openchamber-part-shells')) {
        if (sessionID === 'ses_root' && rootMessageFailure) return new Response(JSON.stringify({ message: 'full root record unavailable' }), { status: 400, headers: { 'content-type': 'application/json' } });
        return new Response(JSON.stringify({ data: wireRecords.map((record) => fullRecords.get(record.id) ?? record), cursor: {} }), { headers: { 'content-type': 'application/json' } });
      }
      return new Response(JSON.stringify({ data: wireRecords, cursor: {} }), { headers: { 'content-type': 'application/json' } });
    }
    const messageID = url.pathname.split('/').at(-1) ?? '';
    if (sessionID === 'ses_root' && messageID === 'root_answer' && rootMessageFailure) {
      return new Response(JSON.stringify({ message: 'full root record unavailable' }), { status: 400, headers: { 'content-type': 'application/json' } });
    }
    const full = fullRecords.get(messageID);
    if (full) return new Response(JSON.stringify({ data: full }), { headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({}), { headers: { 'content-type': 'application/json' } });
  };

  setSessions([
    session('ses_root', { title: 'Root', directory: '/repo' }),
    session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' }),
  ]);
  const childStores = new ChildStoreManager();
  const loader = new SessionMessageLoader(childStores, { sdk: opencodeClient, runtimeKey: getRuntimeKey() });
  loadRecordsOverride = async ({ directory, sessionID }) => {
    try {
      return await loader.readCompleteSnapshot({ directory, sessionID });
    } finally {
      if (rootMessageFailure && sessionID === 'ses_root') finishRootFailureRead();
    }
  };

  try {
    const markdown = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' }, 'markdown', true);
    const html = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' }, 'html', true);
    const exported = z.object({
      source: z.record(z.string(), z.object({
        records: z.array(z.object({ parts: z.array(z.object({
          type: z.string(),
          text: z.string().optional(),
          state: z.object({
            output: z.string().optional(),
            attachments: z.array(z.object({ filename: z.string().optional() })).optional(),
          }).optional(),
        })) })),
      })),
      events: z.array(z.object({ kind: z.string(), timestamp: z.number().optional(), origin: z.object({ messageID: z.string() }) })),
    }).parse(JSON.parse(await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' }, 'json')));
    childPageFailure = true;
    loader.invalidateSession({ directory: '/other', sessionID: 'ses_child' });
    const partial = z.object({
      source: z.record(z.string(), z.unknown()),
      findings: z.array(z.object({ kind: z.string() })),
    }).parse(JSON.parse(await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' }, 'json')));
    rootMessageFailure = true;
    loader.invalidateSession({ directory: '/repo', sessionID: 'ses_root' });
    const savesBeforeRootFailure = savedDocumentCount;
    await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' }, 'json', false, true, rootFailureRead);

    for (const output of [markdown, html]) {
      expect(output.indexOf('root before')).toBeLessThan(output.indexOf('complete root output'));
      expect(output.indexOf('complete root output')).toBeLessThan(output.indexOf('root after'));
      expect(output).toContain('result.txt');
      expect(output.indexOf('child before')).toBeLessThan(output.indexOf('complete child output'));
      expect(output.indexOf('complete child output')).toBeLessThan(output.indexOf('child after'));
    }
    const rootParts = exported.source.ses_root.records.flatMap((record) => record.parts);
    const childParts = exported.source.ses_child.records.flatMap((record) => record.parts);
    const jsonDocument = JSON.stringify(exported);
    expect(jsonDocument.indexOf('root before')).toBeLessThan(jsonDocument.indexOf('complete root output'));
    expect(jsonDocument.indexOf('complete root output')).toBeLessThan(jsonDocument.indexOf('root after'));
    expect(exported.events.filter((event) => event.origin.messageID === 'root_answer').map((event) => event.kind)).toEqual(['message', 'tool', 'message']);
    expect(exported.events.filter((event) => event.origin.messageID === 'child_answer').map((event) => event.kind)).toEqual(['message', 'tool', 'message']);
    expect(rootParts.some((part) => part.type === 'tool' && part.state?.output === 'complete root output'
      && part.state.attachments?.some((attachment) => attachment.filename === 'result.txt'))).toBe(true);
    expect(childParts.some((part) => part.type === 'tool' && part.state?.output === 'complete child output')).toBe(true);
    expect(partial.findings.some((finding) => finding.kind === 'missing-session')).toBe(true);
    expect(partial.source.ses_child).toBeUndefined();
    const rootHistoryRequests = requests.filter((request) => new URL(request.url).pathname.endsWith('/api/session/ses_root/message'));
    expect(rootHistoryRequests.length > 0).toBe(true);
    expect(rootHistoryRequests.every((request) => !request.headers.has('x-openchamber-part-shells'))).toBe(true);
    expect(savedDocumentCount).toBe(savesBeforeRootFailure);
    expect(recordReads.some((read) => read.directory === '/other' && read.sessionID === 'ses_child')).toBe(true);
    expect(requests.some((request) => request.headers.get('x-opencode-part-shells') === 'v1')).toBe(false);
    expect(requests.some((request) => new URL(request.url).pathname.includes('/message/root_answer'))).toBe(false);
    expect(requests.some((request) => new URL(request.url).pathname.includes('/message/child_answer'))).toBe(false);
  } finally {
    childPageFailure = false;
    rootMessageFailure = false;
    loadRecordsOverride = null;
    runtimeResponse = null;
    loader.dispose();
    childStores.disposeAll();
  }
});

describe('the export reads every session from its own directory', () => {
  test('a descendant in another directory is loaded', async () => {
    setRecords([
      ['/repo', 'ses_root', rootRecords],
      ['/other', 'ses_child', childRecords],
    ]);
    setSessions([
      session('ses_root', { title: 'Root', directory: '/repo' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' }),
    ]);

    const output = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    // The child runs in another directory, so its records live in another
    // session store. Read from the root's directory there is nothing there.
    expect(recordReads.some((read) => read.directory === '/other' && read.sessionID === 'ses_child')).toBe(true);
    expect(output).toContain('Verdict: changes required.');
    expect(output).not.toContain('Incomplete export');
  });

  test('a nested descendant is loaded from its own directory', async () => {
    setRecords([
      ['/repo', 'ses_root', rootRecords],
      ['/other', 'ses_child', childRecordsWithGrandchild],
      ['/third', 'ses_grand', grandRecords],
    ]);
    setSessions([
      session('ses_root', { title: 'Root', directory: '/repo' }),
      session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' }),
      session('ses_grand', { title: 'Grand', parentID: 'ses_child', directory: '/third' }),
    ]);

    const output = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    expect(recordReads.some((read) => read.directory === '/third' && read.sessionID === 'ses_grand')).toBe(true);
    expect(output).toContain('Deeper work');
    expect(output).not.toContain('Incomplete export');
  });
});

describe('the export waits for the whole session list before it claims a tree', () => {
  const rootSession = session('ses_root', { title: 'Root', directory: '/repo' });
  const childSession = session('ses_child', { title: 'Child', parentID: 'ses_root', directory: '/other' });

  test('an export that covers the sub-agent sessions waits for the list', async () => {
    // The list holds the root only: the child session has not arrived yet.
    setPartialSessions([rootSession]);
    setRecords([
      ['/repo', 'ses_root', rootRecords],
      ['/other', 'ses_child', childRecords],
    ]);

    const listGate = deferred<void>();
    listLoadGate = listGate.promise;
    listLoadOutcome = { sessions: [rootSession, childSession], complete: true };

    const { written, stop } = await openAndConfirmExport({ sessionID: 'ses_root', directory: '/repo' });

    // The export waits for the list: it has read nothing yet, so it cannot
    // have claimed a tree.
    expect(listLoads).toBe(1);
    expect(recordReads.length).toBe(0);

    listGate.resolve();

    const output = await written;

    // The child arrived with the list, and its transcript is in the
    // document, read from the directory it runs in.
    expect(output).toContain('Verdict: changes required.');
    expect(recordReads.some((read) => read.directory === '/other' && read.sessionID === 'ses_child')).toBe(true);
    expect(output).not.toContain('Incomplete export');
    await stop();
  });

  test('an export of the root session alone does not wait for the list', async () => {
    // The lineage is not walked at all, so the list's completeness is not
    // the export's business.
    setPartialSessions([rootSession]);
    setRecords([['/repo', 'ses_root', rootRecords]]);

    const { written, stop } = await openAndConfirmExport(
      { sessionID: 'ses_root', directory: '/repo' },
      { includeSubagents: false },
    );

    expect(listLoads).toBe(0);

    const output = await written;

    expect(output).toContain('Do the work');
    expect(output).not.toContain('Incomplete export');
    await stop();
  });

  test('an export that ran against an incomplete list says so in the document', async () => {
    setPartialSessions([rootSession]);
    setRecords([['/repo', 'ses_root', rootRecords]]);

    // The load failed, so the list is still not the whole list. The export
    // runs anyway, and the document says what it could not establish.
    listLoadOutcome = { sessions: [rootSession], complete: false };

    const output = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    expect(output).toContain('The session list was still being read when this export ran');
    expect(toastWarnings.some((message) => message.includes('the session list was still being read'))).toBe(true);
  });
});

describe('an export that could not read a pending inbox', () => {
  test('keeps the history and says the pending message may be missing', async () => {
    setSessions([session('ses_root', { title: 'Root', directory: '/repo' })]);
    setRecords([['/repo', 'ses_root', rootRecords]]);
    loadRecordsOverride = async () => ({ records: rootRecords, inboxUnavailable: true });

    const output = await exportSessionTo({ sessionID: 'ses_root', directory: '/repo' });

    // The history was read, so the document carries it.
    expect(output).toContain('Do the work');
    expect(output).toContain('The pending inbox of the session "Root" could not be read');
    expect(toastWarnings.some((message) => message.includes('a pending inbox could not be read'))).toBe(true);
  });
});
