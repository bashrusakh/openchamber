import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { I18nProvider } from '@/lib/i18n';
import { useSessionFoldersStore, type SessionFolder } from '@/stores/useSessionFoldersStore';
import { useSessionMultiSelectStore } from '@/stores/useSessionMultiSelectStore';
import { installHookTestDom } from '../test-utils/testDom';
import type { SidebarFolderTarget } from './useSidebarBulkActions';

type BulkActionCapture = {
  scopeFolders: readonly { scopeKey: string; folder: SessionFolder }[];
  onMoveToFolder: (target: SidebarFolderTarget) => void;
  onCreateFolderAndMove: () => void;
};

let bulkActionCapture: BulkActionCapture | null = null;

mock.module('./BulkActionBar', () => ({
  BulkActionBar: (props: BulkActionCapture) => {
    bulkActionCapture = props;
    return null;
  },
}));

mock.module('./ConfirmDialogs', () => ({
  BulkSessionDeleteConfirmDialog: () => null,
}));

const { SessionBulkActions } = await import('./SessionBulkActions');

describe('SessionBulkActions public behavior', () => {
  test('moves the selected sessions into a newly created folder while a row edit is active', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const cssDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'CSS');
    const renameRequests: Array<{ scopeKey: string; folder: { id: string; name: string } }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    useSessionFoldersStore.setState({
      foldersMap: {},
      addSessionsToFolder: (scopeKey, folderId, ids) => moved.push({ scopeKey, folderId, ids }),
    });
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['session-a']),
      scopeKey: 'project-a',
      anchorId: 'session-a',
    });
    Object.defineProperty(globalThis, 'CSS', {
      configurable: true,
      value: { escape: (value: string) => value },
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForSelectionScope={() => [{ scopeKey: '/workspace', directory: '/workspace' }]}
            isInlineEditing
            startFolderRename={(scopeKey, folder) => renameRequests.push({ scopeKey, folder })}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture).not.toBeNull();

      await act(async () => bulkActionCapture?.onCreateFolderAndMove());
       const createdFolder = useSessionFoldersStore.getState().foldersMap['/workspace']?.[0];
       expect(createdFolder?.name).toBe('New folder');
       expect(renameRequests).toEqual([{ scopeKey: '/workspace', folder: createdFolder }]);
       expect(moved).toEqual([{ scopeKey: '/workspace', folderId: createdFolder?.id ?? '', ids: ['session-a'] }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      if (cssDescriptor) Object.defineProperty(globalThis, 'CSS', cssDescriptor);
      else Reflect.deleteProperty(globalThis, 'CSS');
      bulkActionCapture = null;
      dom.restore();
    }
  });

  test('keeps duplicate folder ids scoped and resolves bulk moves by target scope', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const originalFolders = useSessionFoldersStore.getState();
    const originalSelection = useSessionMultiSelectStore.getState();
    const removals: Array<{ scopeKey: string; ids: string[] }> = [];
    const moved: Array<{ scopeKey: string; folderId: string; ids: string[] }> = [];
    const rootFolder: SessionFolder = { id: 'same-id', name: 'Root folder', parentId: null, sessionIds: ['session-a'], createdAt: 1 };
    const worktreeFolder: SessionFolder = { id: 'same-id', name: 'Worktree folder', parentId: null, sessionIds: [], createdAt: 2 };
    useSessionFoldersStore.setState({
      foldersMap: {
        '/workspace': [rootFolder],
        '/workspace/worktree': [worktreeFolder],
      },
      removeSessionsFromFolders: (scopeKey, ids) => removals.push({ scopeKey, ids }),
      addSessionsToFolder: (scopeKey, folderId, ids) => moved.push({ scopeKey, folderId, ids }),
    });
    useSessionMultiSelectStore.setState({
      enabled: true,
      selectedIds: new Set(['session-a']),
      scopeKey: 'project-a',
      anchorId: 'session-a',
    });

    try {
      await act(async () => root.render(
        <I18nProvider>
          <SessionBulkActions
            getFolderScopesForSelectionScope={() => [
              { scopeKey: '/workspace', directory: '/workspace' },
              { scopeKey: '/workspace/worktree', directory: '/workspace/worktree' },
            ]}
            isInlineEditing={false}
            startFolderRename={() => undefined}
          />
        </I18nProvider>,
      ));
      expect(bulkActionCapture?.scopeFolders.map(({ scopeKey, folder }) => `${scopeKey}:${folder.id}`)).toEqual([
        '/workspace:same-id',
        '/workspace/worktree:same-id',
      ]);

      await act(async () => bulkActionCapture?.onMoveToFolder({ scopeKey: '/workspace/worktree', folderId: 'same-id' }));
      expect(removals).toEqual([{ scopeKey: '/workspace', ids: ['session-a'] }]);
      expect(moved).toEqual([{ scopeKey: '/workspace/worktree', folderId: 'same-id', ids: ['session-a'] }]);
    } finally {
      await act(async () => root.unmount());
      useSessionFoldersStore.setState(originalFolders, true);
      useSessionMultiSelectStore.setState(originalSelection, true);
      bulkActionCapture = null;
      dom.restore();
    }
  });
});
