import { describe, expect, mock, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionNode } from '../types';
import type { SessionNodeItemProps } from './SessionNodeItem';

// SessionNodeItem's menu graph includes ProviderLogo, whose Vite-only asset
// discovery is unavailable under Bun. The comparator is module-local behavior;
// keep this focused test from importing that unrelated render-only dependency.
mock.module('@/components/multirun/MultiRunFusionDialog', () => ({
  MultiRunFusionDialog: () => null,
}));

const { SessionNodeItem } = await import('./SessionNodeItem');

type SessionNodeItemWithComparator = typeof SessionNodeItem & {
  compare: (previous: SessionNodeItemProps, next: SessionNodeItemProps) => boolean;
};

const hasMemoComparator = (component: typeof SessionNodeItem): component is SessionNodeItemWithComparator => (
  Object.prototype.hasOwnProperty.call(component, 'compare')
);

if (!hasMemoComparator(SessionNodeItem)) {
  throw new Error('SessionNodeItem memo comparator is unavailable');
}

// SAFETY: React.memo stores its custom comparator on the memoized component;
// this narrow test hook reads that runtime metadata without mounting the row.
const compareSessionNodeItemProps = SessionNodeItem.compare;

const noop = () => undefined;

// SAFETY: the comparator only reads these session fields from the fixture.
const session = { id: 'session', title: 'Session', directory: '/workspace' } as Session;
const node: SessionNode = { session, children: [], worktree: null };

const baseProps = (): SessionNodeItemProps => ({
  node,
  groupDirectory: '/workspace',
  projectId: 'project',
  folderOwnerKey: 'project',
  selectionScopeKey: 'project',
  pinnedSessionIds: new Set(),
  expandedParents: new Set(),
  hasSessionSearchQuery: false,
  normalizedSessionSearchQuery: '',
  notifyOnSubtasks: false,
  editingId: null,
  setEditingId: noop,
  editTitle: '',
  setEditTitle: noop,
  handleSaveEdit: noop,
  handleCancelEdit: noop,
  toggleParent: noop,
  handleSessionSelect: noop,
  handleSessionDoubleClick: noop,
  handleShareSession: noop,
  copiedSessionId: null,
  handleCopyShareUrl: noop,
  handleCopySessionId: noop,
  handleUnshareSession: noop,
  openSidebarMenuKey: null,
  setOpenSidebarMenuKey: noop,
  createFolderAndStartRename: () => null,
  handleDeleteSession: noop,
  handleRestoreSession: noop,
  startSessionWorktreeMenuLoad: () => ({
    cachedTargets: [],
    refreshTargets: Promise.resolve([]),
  }),
  mobileVariant: false,
  alwaysShowActions: false,
  subtreeContainsEditing: new Set(),
  menuOpenSessionId: null,
  nodeStructureKey: 'session',
});

describe('sessionNodeItemPropsChange identity behavior', () => {
  const identityChanges = [
    ['folderOwnerKey', 'folder-owner-a', 'folder-owner-b'],
    ['selectionScopeKey', 'selection-scope-a', 'selection-scope-b'],
  ] as const;

  for (const [key, previousValue, nextValue] of identityChanges) {
    test(`invalidates the memo boundary when ${key} changes`, () => {
      const previous = { ...baseProps(), [key]: previousValue };
      const next = { ...previous, [key]: nextValue };

      expect(compareSessionNodeItemProps(previous, next)).toBe(false);
    });
  }

  test('keeps the bailout when owner and scope values are equivalent', () => {
    const previous = baseProps();
    const equivalent = { ...previous, folderOwnerKey: 'project', selectionScopeKey: 'project' };

    expect(compareSessionNodeItemProps(previous, equivalent)).toBe(true);
  });
});
