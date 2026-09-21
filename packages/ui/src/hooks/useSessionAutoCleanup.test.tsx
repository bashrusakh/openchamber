import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { Window } from 'happy-dom';

// The hook renders React and reads several stores; happy-dom must be installed
// before any store module evaluates.
const dom = new Window({ url: 'http://localhost' });
const originals = new Map<string, PropertyDescriptor | undefined>();
for (const [name, value] of Object.entries({
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  localStorage: dom.localStorage,
  Element: dom.Element,
  HTMLElement: dom.HTMLElement,
  Node: dom.Node,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  MutationObserver: dom.MutationObserver,
  IS_REACT_ACT_ENVIRONMENT: true,
})) {
  originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
}

let sweepCalls = 0;
let rejectNext = false;
mock.module('@/lib/consult/gc', () => ({
  sweepStaleConsultAdvisorForks: async () => {
    sweepCalls += 1;
    if (rejectNext) {
      rejectNext = false;
      throw new Error('sweep boom');
    }
    return { deletedIds: [], failedIds: [] };
  },
}));

const globalSessions = await import('@/stores/useGlobalSessionsStore');
let loadCalls = 0;
mock.module('@/stores/useGlobalSessionsStore', () => ({
  ...globalSessions,
  ensureGlobalSessionsLoaded: async () => {
    loadCalls += 1;
    return { activeSessions: [], archivedSessions: [] };
  },
}));

const { useSessionAutoCleanup } = await import('./useSessionAutoCleanup');
const { useGlobalSessionsStore } = globalSessions;
const { useSessionUIStore } = await import('@/sync/session-ui-store');
const { useUIStore } = await import('@/stores/useUIStore');

type CleanupOptions = { autoRun?: boolean; enabled?: boolean };
let options: CleanupOptions = {};
let host: HTMLDivElement | null = null;
let root: Root | null = null;

const Probe = () => {
  useSessionAutoCleanup(options);
  return null;
};

const settle = async () => {
  await act(async () => { await Promise.resolve(); });
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  sweepCalls = 0;
  rejectNext = false;
  loadCalls = 0;
  options = {};
  useUIStore.setState({ autoDeleteEnabled: false });
  useGlobalSessionsStore.setState({ status: 'loading' });
  useSessionUIStore.setState({ currentSessionId: 'ses_parent' });
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterAll(() => {
  dom.happyDOM.cancelAsync();
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

describe('useSessionAutoCleanup consult fork sweep', () => {
  test('sweeps when cleanup is enabled and the cache is ready, independent of autoRun', async () => {
    // N3: embedded chats and the settings surface run with autoRun: false and
    // must still collect leftover advisor forks.
    options = { autoRun: false };
    await act(async () => { root?.render(React.createElement(Probe)); });
    await settle();
    expect(sweepCalls).toBe(0);

    await act(async () => { useGlobalSessionsStore.setState({ status: 'ready' }); });
    await settle();
    expect(sweepCalls).toBe(1);

    // Parent visit re-runs it.
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses_other' }); });
    await settle();
    expect(sweepCalls).toBe(2);

    // A rejecting sweep is swallowed and does not stop later visits.
    rejectNext = true;
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses_third' }); });
    await settle();
    expect(sweepCalls).toBe(3);
    await act(async () => { useSessionUIStore.setState({ currentSessionId: 'ses_fourth' }); });
    await settle();
    expect(sweepCalls).toBe(4);

    // enabled: false (hidden embedded chat) is the explicit bound.
    await act(async () => { options = { enabled: false }; root?.render(React.createElement(Probe)); });
    await settle();
    expect(sweepCalls).toBe(4);

    await act(async () => { root?.unmount(); });
    root = null;
  });

  test('loads the global cache whenever cleanup is enabled', async () => {
    options = { autoRun: false };
    await act(async () => { root?.render(React.createElement(Probe)); });
    await settle();
    expect(loadCalls).toBeGreaterThan(0);

    await act(async () => { root?.unmount(); });
    root = null;
  });

  test('does not sweep while the global cache is not ready', async () => {
    options = { autoRun: false };
    await act(async () => { root?.render(React.createElement(Probe)); });
    await settle();
    expect(sweepCalls).toBe(0);

    await act(async () => { root?.unmount(); });
    root = null;
  });
});
