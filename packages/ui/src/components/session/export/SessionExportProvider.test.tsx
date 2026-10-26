/**
 * The app's one export dialog.
 *
 * The Header and the Sidebar open the same dialog, so the coverage the
 * reader chose is one thing: it reaches the session it was made for, it
 * survives the row it was made from, and both entry points see it.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@/lib/opencode/model';

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

// The export reads the session's history through the sync runtime. The
// dialog's own state is what this test is about, so the read is stubbed.
mock.module('@/sync/use-sync', () => ({
  useSessionMessageRecordsForExport: () => async () => null,
}));

const { I18nProvider } = await import('@/lib/i18n');
const { useGlobalSessionsStore } = await import('@/stores/useGlobalSessionsStore');
const { SessionExportProvider, useSessionExportOpener } = await import('./SessionExportProvider');

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

/** Puts the sessions into the store, the way the app holds them. */
const setSessions = (sessions: Session[]) => {
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

/** The openers the tree was given, so a change of identity is visible. */
const seenOpeners = new Set<(target: { sessionID: string; title: string; directory: string }) => void>();

/** How often each place that opens the export was drawn. */
const renderCounts = new Map<string, number>();

/**
 * A place that opens the export, the way the Header and a sidebar row do.
 */
const Opener = ({ label, sessionID }: { label: string; sessionID: string }) => {
  const openExport = useSessionExportOpener();
  seenOpeners.add(openExport);
  renderCounts.set(label, (renderCounts.get(label) ?? 0) + 1);
  return (
    <button
      type="button"
      onClick={() => openExport({ sessionID, title: sessionID, directory: '/repo' })}
    >
      {label}
    </button>
  );
};

const Harness = ({ rowKey, withHeader }: { rowKey: number; withHeader: boolean }) => (
  <I18nProvider>
    <SessionExportProvider>
      {withHeader ? <Opener label="header" sessionID="ses_root" /> : null}
      {/* The row's key changes when the sidebar takes the row away and gives
          it back, so the consumer is unmounted and mounted again. */}
      <Opener key={rowKey} label="row" sessionID="ses_root" />
      <Opener label="other" sessionID="ses_other" />
    </SessionExportProvider>
  </I18nProvider>
);

const render = async (): Promise<{
  container: HTMLElement;
  remount: (rowKey: number, withHeader: boolean) => Promise<void>;
}> => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const remount = async (rowKey: number, withHeader: boolean) => {
    await act(async () => { root.render(<Harness rowKey={rowKey} withHeader={withHeader} />); });
  };
  await remount(0, false);
  return { container, remount };
};

const clickButton = async (container: HTMLElement, label: string) => {
  const target = [...container.querySelectorAll<HTMLElement>('button')].find((candidate) => (
    candidate.textContent?.trim() === label
  ));
  expect(target).toBeTruthy();
  await act(async () => { target?.click(); });
};

/** Whether the sub-agent switch is on. */
const coverageOn = (container: HTMLElement): boolean | undefined => (
  container.querySelector<HTMLInputElement>('input[type="checkbox"]')?.checked
);

const toggleCoverage = async (container: HTMLElement) => {
  const box = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(box).toBeTruthy();
  await act(async () => { box?.click(); });
};

beforeEach(() => {
  seenOpeners.clear();
  renderCounts.clear();
  setSessions([
    session('ses_root', { title: 'Root' }),
    session('ses_child', { title: 'Child', parentID: 'ses_root' }),
    session('ses_other', { title: 'Other' }),
    session('ses_other_child', { title: 'Other child', parentID: 'ses_other' }),
  ]);
});

describe('the export dialog', () => {
  test('the Header and the Sidebar share one dialog', async () => {
    const { container, remount } = await render();
    await remount(0, true);

    // One switch, so one dialog: the row and the Header opened the same one.
    expect(container.querySelectorAll('input[type="checkbox"]')).toHaveLength(1);
  });

  test('the coverage the reader chose survives the row being unmounted', async () => {
    const { container, remount } = await render();

    await clickButton(container, 'row');
    expect(coverageOn(container)).toBe(true);

    // The reader leaves the sub-agent work out of this session's export.
    await toggleCoverage(container);
    expect(coverageOn(container)).toBe(false);
    await clickButton(container, 'Cancel');

    // The sidebar virtualizes its rows: this row scrolls out of the window
    // and is unmounted, and a new row for the same session takes its place.
    await remount(1, false);
    await clickButton(container, 'row');

    // The choice is the reader's, and it belongs to the session, so the
    // choice is still in effect.
    expect(coverageOn(container)).toBe(false);
  });

  test('the Header sees the choice the Sidebar made', async () => {
    const { container, remount } = await render();
    await remount(0, true);

    await clickButton(container, 'row');
    await toggleCoverage(container);
    await clickButton(container, 'Cancel');

    // The Header opens the same dialog, so it shows the same choice.
    await clickButton(container, 'header');

    expect(coverageOn(container)).toBe(false);
  });

  test('the choice reaches the session it was made for and no other', async () => {
    const { container } = await render();

    await clickButton(container, 'row');
    await toggleCoverage(container);
    await clickButton(container, 'Cancel');

    await clickButton(container, 'other');

    // Another session's sub-agent work is its own, so the choice does not
    // reach it.
    expect(coverageOn(container)).toBe(true);
  });

  test('the opener keeps its identity when the dialog\'s own state changes', async () => {
    const { container, remount } = await render();
    await remount(0, true);

    await clickButton(container, 'row');
    await toggleCoverage(container);
    await clickButton(container, 'Cancel');
    await clickButton(container, 'header');

    // One opener for the whole tree: a row does not re-render when the
    // reader touches the dialog.
    expect(seenOpeners.size).toBe(1);
  });

  test('the rows below the provider are not drawn again when the dialog changes', async () => {
    const { container } = await render();
    const before = renderCounts.get('row');

    // The dialog opens, closes and changes the reader's choice. None of it
    // is the row's business.
    await clickButton(container, 'row');
    await toggleCoverage(container);
    await clickButton(container, 'Cancel');

    expect(renderCounts.get('row')).toBe(before);
  });

  test('a consumer outside the provider fails loudly', async () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    let caught: Error | null = null;

    // There is no dialog to open, and saying nothing about it would leave
    // the reader with an export that never opens.
    try {
      await act(async () => {
        root.render(<Opener label="row" sessionID="ses_root" />);
      });
    } catch (error) {
      caught = error instanceof Error ? error : null;
    }

    expect(caught).toBeInstanceOf(Error);
    expect(caught?.message).toContain('useSessionExportOpener');
  });
});
