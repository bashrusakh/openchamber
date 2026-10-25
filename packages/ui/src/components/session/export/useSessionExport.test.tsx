/**
 * The export's own writing.
 *
 * The export reads every session from the directory it runs in. A descendant
 * that runs in another directory lives in another session store, so the
 * root's directory would never find its records — and the document would
 * say the transcript could not be loaded.
 */

import { afterAll, describe, expect, mock, test } from 'bun:test';
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

mock.module('@/components/ui/dialog', () => ({
  Dialog: ({ children }: React.PropsWithChildren) => <>{children}</>,
  DialogContent: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogDescription: ({ children }: React.PropsWithChildren) => <p>{children}</p>,
  DialogFooter: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogHeader: ({ children }: React.PropsWithChildren) => <div>{children}</div>,
  DialogTitle: ({ children }: React.PropsWithChildren) => <h2>{children}</h2>,
}));

mock.module('@/components/ui', () => ({
  toast: { error: () => undefined, success: () => undefined, warning: () => undefined },
}));

/** The records every directory holds, keyed by the session they belong to. */
const recordsByDirectory = new Map<string, Map<string, SessionMessageRecord[]>>();

/** The reads the export made, in the order it made them. */
const recordReads: Array<{ directory: string; sessionID: string }> = [];
let loadRecordsOverride: ((target: { directory: string; sessionID: string }) => Promise<SessionMessageRecord[] | null>) | null = null;
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
    return recordsByDirectory.get(directory)?.get(sessionID) ?? null;
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

const { I18nProvider } = await import('@/lib/i18n');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { useSessionExport } = await import('./useSessionExport');
const { opencodeClient } = await import('@/lib/opencode/client');
const { ChildStoreManager } = await import('@/sync/child-store');
const { SessionMessageLoader } = await import('@/sync/session-message-loader');

afterAll(() => {
  browser.close();
});

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
 * Exports a session and hands back the document it wrote.
 *
 * The dialog is opened and confirmed, the way a reader does it, so the test
 * reads what the export writes.
 */
const exportSessionTo = async (
  target: { sessionID: string; directory: string },
  format: ExportFormat = 'markdown',
  detailed = false,
  noDocumentExpected = false,
  actionSettled?: Promise<void>,
): Promise<string> => {
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

  if (format !== 'markdown') {
    await act(async () => {
      container.querySelector<HTMLElement>(`button[aria-label="${format.toUpperCase()}"]`)?.click();
    });
  }
  if (detailed) {
    await act(async () => {
      container.querySelector<HTMLElement>('button[aria-label="Full details"]')?.click();
    });
  }
  await act(async () => {
    const confirm = [...container.querySelectorAll<HTMLElement>('button')].find((candidate) => (
      candidate.textContent?.trim() === 'Export'
    ));
    expect(confirm).toBeTruthy();
    confirm?.click();
    if (noDocumentExpected) {
      await actionSettled;
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  });

  if (noDocumentExpected) {
    await act(async () => root.unmount());
    container.remove();
    return '';
  }

  const outputDocument = await written;
  await act(async () => root.unmount());
  container.remove();
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
