import { afterAll, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { Window } from 'happy-dom';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { SessionRowOrderProvider, useSessionRowOrderRegistry, type SessionRowOrderRegistry } from '../sessions/sessionRowOrder';
import { installHookTestDom } from '../test-utils/testDom';
import type { SessionSearchRowsProps } from './SessionSearchRows';
import type { SessionSearchRowModel } from './sessionSearchRowModel';
import { I18nProvider } from '@/lib/i18n';

const renderedRows: SessionTreeItemProps[] = [];
type RegistryCapture = { current: SessionRowOrderRegistry | null };

const installRealTestDom = () => {
  const browser = new Window({ url: 'http://localhost' });
  const descriptors = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window: browser,
    document: browser.document,
    navigator: browser.navigator,
    localStorage: browser.localStorage,
    Element: browser.Element,
    HTMLElement: browser.HTMLElement,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    descriptors.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  Object.defineProperty(browser.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get: () => 32,
  });
  const container = document.createElement('div');
  document.body.append(container);
  return {
    container,
    restore: async () => {
      await browser.happyDOM.close();
      for (const [key, descriptor] of descriptors) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    },
  };
};

// Install a real DOM before loading react-virtual. Its layout-effect choice is
// made at module evaluation time, so the virtualizer must see `document` here.
const initialDom = installRealTestDom();
afterAll(async () => initialDom.restore());

mock.module('../sessions/SessionTreeItem', () => ({
  SessionTreeItem: (props: SessionTreeItemProps) => {
    renderedRows.push(props);
    return <div data-session-row>{props.node.session.id}</div>;
  },
}));

mock.module('../folders/sessionFolderDnd', () => ({
  DroppableFolderWrapper: ({ children }: { children: (ref: () => void, isOver: boolean) => React.ReactNode }) => <>{children(() => undefined, false)}</>,
  SessionFolderDndScope: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module('./sortableItems', () => ({
  SortableProjectItem: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

mock.module('@/stores/useGitHubPrStatusStore', () => ({
  getGitHubPrStatusKey: () => '',
  usePrVisualSummary: () => null,
}));

const { SessionSearchRows } = await import('./SessionSearchRows');

const makeSession = (id: string): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title: `Release ${id}`,
  version: '1',
  directory: '/repo/project',
  time: { created: 1, updated: 1 },
});

const makeModel = (count: number): SessionSearchRowModel => {
  const rows = Array.from({ length: count }, (_, index) => {
    const session = makeSession(`ses_${index}`);
    return {
      kind: 'session' as const,
      key: `session:${session.id}`,
      node: { session, children: [], worktree: null },
      depth: 0,
      projectId: 'project',
      groupDirectory: '/repo/project',
      folderOwnerKey: 'project',
      archivedBucket: false,
      renderContext: 'project' as const,
    };
  });
  return {
    rows,
    entries: rows.map((row) => ({ id: row.node.session.id, rowKey: row.key, scopeKey: 'project', archived: false })),
    projectSections: [],
    hasResults: true,
    searchMatchCount: count,
  };
};

const makeProps = (
  model: SessionSearchRowModel,
  scrollContainerRef: React.RefObject<HTMLElement | null> = React.createRef<HTMLElement>(),
): SessionSearchRowsProps => ({
  model,
  scrollContainerRef,
  homeDirectory: '/home/user',
  hideDirectoryControls: false,
  isDesktopShellRuntime: false,
  stickyZoneHeaders: false,
  mobileVariant: false,
  alwaysShowActions: false,
  singleProjectMode: false,
  projectPickerOptions: [],
  activeProjectId: 'project',
  projectRepoStatus: new Map(),
  openSidebarMenuKey: null,
  setOpenSidebarMenuKey: () => undefined,
  sessionProps: {
    hasSessionSearchQuery: true,
    normalizedSessionSearchQuery: 'release',
    mobileVariant: false,
    alwaysShowActions: false,
    activeProjectId: 'project',
    notifyOnSubtasks: false,
    pinnedSessionIds: new Set(),
    expandedParents: new Set(),
    editingId: null,
    editTitle: '',
    copiedSessionId: null,
    setEditingId: () => undefined,
    setEditTitle: () => undefined,
    toggleParent: () => undefined,
    setOpenSidebarMenuKey: () => undefined,
    allowReselect: false,
    resetSessionSearch: () => undefined,
    deleteSessionConfirm: null,
    setDeleteSessionConfirm: () => undefined,
    startFolderRename: () => undefined,
    setCopiedSessionId: () => undefined,
    startSessionWorktreeMenuLoad: () => ({ cachedTargets: [], refreshTargets: Promise.resolve([]) }),
    folderRename: null,
    setFolderRenameDraft: () => undefined,
    clearFolderRename: () => undefined,
    onToggleCollapsedGroup: () => undefined,
  },
  toggleProject: () => undefined,
  setActiveProjectIdOnly: () => undefined,
  setSessionSwitcherOpen: () => undefined,
  openNewSessionDraft: () => undefined,
  openNewWorktreeDialog: () => undefined,
  openWorktreesPage: () => undefined,
  openProjectEditDialog: () => undefined,
  removeProject: () => undefined,
  setSingleProjectId: () => undefined,
  onNewChat: () => undefined,
  toggleActivitySection: () => undefined,
  projectHeaderSentinelRefs: {
    current: new Map(),
  },
  renderProjectStatusIndicator: undefined,
});

describe('SessionSearchRows public behavior', () => {
  test('keeps the logical row registry complete while the initial DOM mount is bounded', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const registryCapture: RegistryCapture = { current: null };
    const model = makeModel(260);

    try {
      await act(async () => root.render(
        <SessionRowOrderProvider>
          <RegistryProbe capture={registryCapture} />
          <SessionSearchRows {...makeProps(model)} />
        </SessionRowOrderProvider>,
      ));

      expect(renderedRows).toHaveLength(0);
      // SAFETY: the search content wrapper is the only child mounted by the
      // mocked DnD scope in this unresolved-scroller fixture.
      const content = dom.container.childNodes[0] as HTMLElement | undefined;
      expect(content?.style.height).toBe(`${260 * 32}px`);
      expect(registryCapture.current?.getOrderedEntries()).toHaveLength(260);
      expect(registryCapture.current?.getOrderedEntries()[0]?.id).toBe('ses_0');
      expect(registryCapture.current?.getOrderedEntries()[259]?.id).toBe('ses_259');
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      dom.restore();
    }
  });

  test('mounts only the viewport window plus overscan once the scroll element is available', async () => {
    const dom = installRealTestDom();
    const scrollContainer = dom.container;
    scrollContainer.className = 'overlay-scrollbar-container';
    Object.defineProperty(scrollContainer, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(scrollContainer, 'offsetWidth', { configurable: true, value: 320 });
    scrollContainer.getBoundingClientRect = () => new window.DOMRect(0, 0, 320, 96);
    const root = createRoot(scrollContainer);
    const model = makeModel(260);
    renderedRows.length = 0;

    try {
      await act(async () => root.render(<SessionSearchRows {...makeProps(model)} />));

      expect(renderedRows.length).toBeGreaterThan(0);
      expect(renderedRows.length).toBeLessThan(model.rows.length);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('passes distinct row keys to duplicate session occurrences', async () => {
    const dom = installRealTestDom();
    Object.defineProperty(dom.container, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(dom.container, 'offsetWidth', { configurable: true, value: 320 });
    dom.container.className = 'overlay-scrollbar-container';
    const root = createRoot(dom.container);
    const session = makeSession('ses_duplicate');
    const node = { session, children: [], worktree: null };
    const model: SessionSearchRowModel = {
      rows: [
        {
          kind: 'session',
           key: 'activity:active-now:ses_duplicate:0:session:ses_duplicate',
          node,
          depth: 0,
           projectId: 'project',
           groupDirectory: '/repo/project',
           folderOwnerKey: 'project',
           archivedBucket: false,
          renderContext: 'recent',
        },
        {
          kind: 'session',
           key: 'project:project:session:ses_duplicate',
          node,
          depth: 0,
           projectId: 'project',
           groupDirectory: '/repo/project',
           folderOwnerKey: 'project',
           archivedBucket: false,
          renderContext: 'project',
        },
      ],
      entries: [
        { id: session.id, rowKey: 'activity:active-now:ses_duplicate:0:session:ses_duplicate', scopeKey: 'project', archived: false },
        { id: session.id, rowKey: 'project:project:session:ses_duplicate', scopeKey: 'project', archived: false },
      ],
      projectSections: [],
      hasResults: true,
      searchMatchCount: 1,
    };

    try {
      await act(async () => root.render(
        <SessionRowOrderProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} /></SessionRowOrderProvider>,
      ));

      expect([...new Set(renderedRows.map((row) => row.dragKey))]).toEqual([
         'activity:active-now:ses_duplicate:0:session:ses_duplicate',
        'project:project:session:ses_duplicate',
      ]);
      expect([...new Set(renderedRows.map((row) => row.rowKey))]).toEqual([
         'activity:active-now:ses_duplicate:0:session:ses_duplicate',
        'project:project:session:ses_duplicate',
      ]);
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });

  test('marks search activity headers as sticky when the display setting is enabled', async () => {
    const dom = installRealTestDom();
    Object.defineProperty(dom.container, 'offsetHeight', { configurable: true, value: 96 });
    Object.defineProperty(dom.container, 'offsetWidth', { configurable: true, value: 320 });
    dom.container.className = 'overlay-scrollbar-container';
    const root = createRoot(dom.container);
    const model: SessionSearchRowModel = {
      rows: [{
        kind: 'activity-header',
        key: 'activity:chats:header',
        activityKey: 'chats',
        showNewChat: true,
        isCollapsed: false,
      }],
      entries: [],
      projectSections: [],
      hasResults: true,
      searchMatchCount: 0,
    };

    try {
      await act(async () => root.render(
        <I18nProvider><SessionSearchRows {...makeProps(model, { current: dom.container })} stickyZoneHeaders /></I18nProvider>,
      ));

      const header = dom.container.querySelector('[data-sidebar-sticky-header="true"]');
      expect(header?.className).toContain('sticky');
      expect(header?.querySelector('[data-sidebar-activity-start="chats"]')).not.toBeNull();
    } finally {
      await act(async () => root.unmount());
      renderedRows.length = 0;
      await dom.restore();
    }
  });
});

const RegistryProbe: React.FC<{ capture: RegistryCapture }> = ({ capture }) => {
  capture.current = useSessionRowOrderRegistry();
  return null;
};
