import { describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { installHookTestDom } from '../test-utils/testDom';

type DragEnd = (event: {
  active: { data: { current: { type: string; sessionId: string; ownerKey?: string | null } } };
  over: { data: { current: { type: string; folderId: string; scopeKey?: string; ownerKey?: string | null } } } | null;
}) => void;

let handleDragEnd: DragEnd | null = null;
const draggableIds: string[] = [];

mock.module('@dnd-kit/core', () => ({
  DndContext: ({ children, onDragEnd }: { children: React.ReactNode; onDragEnd: DragEnd }) => {
    handleDragEnd = onDragEnd;
    return <>{children}</>;
  },
  DragOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PointerSensor: class {},
  closestCenter: () => null,
  useSensor: () => null,
  useSensors: () => [],
  useDraggable: ({ id }: { id: string }) => {
    draggableIds.push(id);
    return { attributes: {}, listeners: {}, setNodeRef: () => undefined, isDragging: false };
  },
  useDroppable: () => ({ setNodeRef: () => undefined, isOver: false }),
}));

const { DraggableSessionRow, SessionFolderDndScope } = await import('./sessionFolderDnd');

describe('SessionFolderDndScope public behavior', () => {
  test('routes a session-folder drop without depending on row edit or menu state', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    const drops: Array<{ sessionId: string; folderId: string; scopeKey: string; ownerKey: string; sourceOwnerKey: string }> = [];

    try {
      await act(async () => root.render(
        <SessionFolderDndScope
          scopeKey="/workspace"
          ownerKey="project-1"
          hasFolders
          onSessionDroppedOnFolder={(sessionId, target, sourceOwnerKey) => drops.push({ sessionId, ...target, sourceOwnerKey })}
        >
          {null}
        </SessionFolderDndScope>,
      ));
      expect(handleDragEnd).not.toBeNull();

      await act(async () => handleDragEnd?.({
         active: { data: { current: { type: 'session', sessionId: 'session-a', ownerKey: 'project-1' } } },
         over: { data: { current: { type: 'folder', folderId: 'folder-a', scopeKey: '/workspace/alternate', ownerKey: 'project-1' } } },
       }));
      expect(drops).toEqual([{
        sessionId: 'session-a',
        folderId: 'folder-a',
        scopeKey: '/workspace/alternate',
        ownerKey: 'project-1',
        sourceOwnerKey: 'project-1',
      }]);

      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-a', ownerKey: 'project-1' } } },
        over: { data: { current: { type: 'folder', folderId: 'folder-b', scopeKey: '/other-project', ownerKey: 'project-2' } } },
      }));
      expect(drops).toHaveLength(1);

      await act(async () => handleDragEnd?.({
        active: { data: { current: { type: 'session', sessionId: 'session-a', ownerKey: 'project-1' } } },
        over: { data: { current: { type: 'folder', folderId: 'folder-stale', scopeKey: '/workspace/alternate' } } },
      }));
      expect(drops).toHaveLength(1);
    } finally {
      await act(async () => root.unmount());
      handleDragEnd = null;
      dom.restore();
    }
  });

  test('keeps duplicate session occurrences on distinct draggable ids', async () => {
    const dom = installHookTestDom();
    const root = createRoot(dom.container);
    draggableIds.length = 0;

    try {
      await act(async () => root.render(
        <>
          <DraggableSessionRow
            sessionId="session-duplicate"
            dragKey="activity:active-now:session-duplicate:0"
            ownerKey="/workspace"
            sessionDirectory="/workspace"
            sessionTitle="Duplicate session"
          >
            <span>Recent occurrence</span>
          </DraggableSessionRow>
          <DraggableSessionRow
            sessionId="session-duplicate"
            dragKey="project:project:session:session-duplicate"
            ownerKey="project-1"
            sessionDirectory="/workspace"
            sessionTitle="Duplicate session"
          >
            <span>Project occurrence</span>
          </DraggableSessionRow>
        </>,
      ));

      expect(draggableIds).toEqual([
        'session-drag:activity:active-now:session-duplicate:0',
        'session-drag:project:project:session:session-duplicate',
      ]);
      expect(new Set(draggableIds).size).toBe(2);
    } finally {
      await act(async () => root.unmount());
      draggableIds.length = 0;
      dom.restore();
    }
  });
});
