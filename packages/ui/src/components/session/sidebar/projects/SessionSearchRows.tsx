import React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Icon } from '@/components/icon/Icon';
import { DirectoryActionIndicator } from '../sessions/DirectoryActionIndicator';
import { SessionTreeItem, type SessionTreeItemProps } from '../sessions/SessionTreeItem';
import { SessionFolderItem } from '../../SessionFolderItem';
import { DroppableFolderWrapper, SessionFolderDndScope, type SessionFolderDropTarget } from '../folders/sessionFolderDnd';
import { FolderDeleteConfirmDialog, type DeleteFolderConfirmState } from '../shell/ConfirmDialogs';
import { useSessionFoldersStore } from '@/stores/useSessionFoldersStore';
import { useUIStore } from '@/stores/useUIStore';
import { sessionEvents } from '@/lib/sessionEvents';
import { cn, formatDirectoryName, formatPathForDisplay } from '@/lib/utils';
import { useI18n } from '@/lib/i18n';
import { getGitHubPrStatusKey, usePrVisualSummary } from '@/stores/useGitHubPrStatusStore';
import { SortableProjectItem } from './sortableItems';
import type {
  SessionSearchActivityHeaderRow,
  SessionSearchEmptyRow,
  SessionSearchFolderRow,
  SessionSearchGroupHeaderRow,
  SessionSearchProjectHeaderRow,
  SessionSearchRow,
  SessionSearchRowModel,
  SessionSearchSessionRow,
} from './sessionSearchRowModel';
import type { SessionGroup, SessionNode } from '../types';
import { formatProjectLabel, isBranchDifferentFromLabel, normalizePath, renderHighlightedText } from '../utils';
import {
  collectSubtreeContainingId,
  computeNodeStructureKey,
  resolveMenuOpenSessionId,
} from '../sessions/sessionNodeItemUtils';
import { getSessionFolderOwnerKey, getSessionFolderScopes } from '../sessions/sessionFolderIdentity';
import type { SessionNodeRenderExtras } from '../sessions/sessionNodeItemUtils';
import { useRegisterSessionRowOrder } from '../sessions/sessionRowOrder';

const ROW_ESTIMATE_PX = 32;
const EMPTY_SESSION_RENDER_EXTRAS: SessionNodeRenderExtras = {
  subtreeContainsEditing: new Set<string>(),
  menuOpenSessionId: null,
  nodeStructureKey: '',
};

const findSearchScrollElement = (content: HTMLElement | null): HTMLElement | null => {
  let ancestor = content?.parentElement ?? null;
  while (ancestor) {
    if (ancestor.classList.contains('overlay-scrollbar-container')) return ancestor;
    ancestor = ancestor.parentElement;
  }
  return null;
};

type SearchSessionProps = Pick<SessionGroupSectionPropsForSearch,
  | 'hasSessionSearchQuery'
  | 'normalizedSessionSearchQuery'
  | 'mobileVariant'
  | 'alwaysShowActions'
  | 'activeProjectId'
  | 'notifyOnSubtasks'
  | 'pinnedSessionIds'
  | 'expandedParents'
  | 'editingId'
  | 'editTitle'
  | 'copiedSessionId'
  | 'setEditingId'
  | 'setEditTitle'
  | 'toggleParent'
  | 'setOpenSidebarMenuKey'
  | 'allowReselect'
  | 'onSessionSelected'
  | 'resetSessionSearch'
  | 'deleteSessionConfirm'
  | 'setDeleteSessionConfirm'
  | 'startFolderRename'
  | 'setCopiedSessionId'
  | 'startSessionWorktreeMenuLoad'
   | 'folderRename'
   | 'setFolderRenameDraft'
   | 'clearFolderRename'
   | 'onToggleCollapsedGroup'
 >;

// Keep this local projection type tied to the existing group props without
// making the scroller's orchestration types part of the search-row module's
// public contract.
type SessionGroupSectionPropsForSearch = {
  hasSessionSearchQuery: boolean;
  normalizedSessionSearchQuery: string;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  activeProjectId: string | null;
  notifyOnSubtasks: boolean;
  pinnedSessionIds: Set<string>;
  expandedParents: Set<string>;
  editingId: string | null;
  editTitle: string;
  copiedSessionId: string | null;
  setEditingId: SessionTreeItemProps['setEditingId'];
  setEditTitle: SessionTreeItemProps['setEditTitle'];
  toggleParent: SessionTreeItemProps['toggleParent'];
  setOpenSidebarMenuKey: SessionTreeItemProps['setOpenSidebarMenuKey'];
  allowReselect: SessionTreeItemProps['allowReselect'];
  onSessionSelected?: SessionTreeItemProps['onSessionSelected'];
  resetSessionSearch: SessionTreeItemProps['resetSessionSearch'];
  deleteSessionConfirm: SessionTreeItemProps['deleteSessionConfirm'];
  setDeleteSessionConfirm: SessionTreeItemProps['setDeleteSessionConfirm'];
  startFolderRename: SessionTreeItemProps['startFolderRename'];
  setCopiedSessionId: SessionTreeItemProps['setCopiedSessionId'];
  startSessionWorktreeMenuLoad: SessionTreeItemProps['startSessionWorktreeMenuLoad'];
  folderRename: { scopeKey: string; folderId: string; draft: string } | null;
  setFolderRenameDraft: (draft: string) => void;
  clearFolderRename: () => void;
  onToggleCollapsedGroup: (groupKey: string) => void;
};

export type SessionSearchRowsProps = {
  model: SessionSearchRowModel;
  scrollContainerRef: React.RefObject<HTMLElement | null>;
  homeDirectory: string | null;
  hideDirectoryControls: boolean;
  isDesktopShellRuntime: boolean;
  mobileVariant: boolean;
  alwaysShowActions: boolean;
  singleProjectMode: boolean;
  projectPickerOptions: Array<{
    id: string;
    projectLabel: string;
    projectDescription: string;
    projectIcon?: string;
    projectColor?: string;
    projectIconImage?: { mime: string; updatedAt: number; source: 'custom' | 'auto' };
    projectIconBackground?: string;
  }>;
  activeProjectId: string | null;
  projectRepoStatus: Map<string, boolean | null>;
  openSidebarMenuKey: string | null;
  setOpenSidebarMenuKey: (key: string | null) => void;
  sessionProps: SearchSessionProps;
  toggleProject: (id: string) => void;
  setActiveProjectIdOnly: (id: string) => void;
  setSessionSwitcherOpen: (open: boolean) => void;
  openNewSessionDraft: (options?: { selectedProjectId?: string | null; directoryOverride?: string | null; targetFolderId?: string; target?: 'chat' | 'project' }) => void;
  openNewWorktreeDialog: () => void;
  openWorktreesPage: (id: string) => void;
  openProjectEditDialog: (id: string) => void;
  removeProject: (id: string) => void;
  setSingleProjectId: (id: string) => void;
  onNewChat: () => void;
  toggleActivitySection: (key: 'chats' | 'active-now') => void;
  stickyZoneHeaders: boolean;
  onRowsMounted?: () => void;
  renderProjectStatusIndicator?: (projectId: string, groups: SessionGroup[]) => React.ReactNode;
  projectHeaderSentinelRefs: React.MutableRefObject<Map<string, HTMLDivElement | null>>;
};

const getProjectLabel = (
  project: SessionSearchProjectHeaderRow['project'],
  homeDirectory: string | null,
): string => formatProjectLabel(project.label?.trim() || formatDirectoryName(project.normalizedPath, homeDirectory) || project.normalizedPath);

const SearchActivityHeader: React.FC<{
  row: SessionSearchActivityHeaderRow;
  collapsed: boolean;
  onToggle: () => void;
  onNewChat: () => void;
  alwaysShowActions: boolean;
  stickyZoneHeaders: boolean;
}> = ({ row, collapsed, onToggle, onNewChat, alwaysShowActions, stickyZoneHeaders }) => {
  const { t } = useI18n();
  const isChats = row.activityKey === 'chats';
  return (
    <div
      className={cn(
        'group/chats relative -mx-2.5',
        stickyZoneHeaders && 'sticky top-0 z-20 bg-sidebar',
      )}
      data-sidebar-sticky-header={stickyZoneHeaders ? 'true' : undefined}
    >
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'group flex w-full items-center gap-1.5 py-1 pl-4 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
          isChats ? 'pr-10' : 'pr-3.5',
        )}
        aria-expanded={!collapsed}
        aria-label={isChats ? t('sessions.sidebar.activity.chatsTitle') : t('sessions.sidebar.activity.recentTitle')}
        data-sidebar-activity-start={row.activityKey}
      >
        <span className="inline-flex h-3.5 w-3.5 items-center justify-center">
          <Icon name={isChats ? 'chat-4' : 'history'} className={cn('h-3.5 w-3.5 text-muted-foreground/80', 'group-hover:hidden')} />
          <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover:inline-flex">
            {collapsed ? <Icon name="arrow-right-s" className="h-3.5 w-3.5" /> : <Icon name="arrow-down-s" className="h-3.5 w-3.5" />}
          </span>
        </span>
        <span className="typography-ui-label font-semibold lowercase text-foreground">
          {isChats ? t('sessions.sidebar.activity.chatsTitle') : t('sessions.sidebar.activity.recentTitle')}
        </span>
      </button>
      {row.showNewChat ? (
        <button
          type="button"
          onClick={(event) => { event.stopPropagation(); onNewChat(); }}
          className={cn(
            'absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
            alwaysShowActions ? 'opacity-100' : 'opacity-0 pointer-events-none group-hover/chats:opacity-100 group-hover/chats:pointer-events-auto group-focus-within/chats:opacity-100 group-focus-within/chats:pointer-events-auto',
          )}
          aria-label={t('sessions.sidebar.header.actions.newSession')}
        >
          <Icon name="add" className="h-4 w-4" />
        </button>
      ) : null}
    </div>
  );
};

const SearchProjectHeader: React.FC<{
  row: SessionSearchProjectHeaderRow;
  props: SessionSearchRowsProps;
  statusIndicator: React.ReactNode;
}> = ({ row, props, statusIndicator }) => {
  const project = row.project;
  const isRepo = Boolean(props.projectRepoStatus.get(project.id));
  const projectLabel = getProjectLabel(project, props.homeDirectory);
  return (
    <SortableProjectItem
      id={project.id}
      disabled
      projectLabel={projectLabel}
      projectDescription={formatPathForDisplay(project.normalizedPath, props.homeDirectory)}
      projectDirectory={project.normalizedPath}
      projectIcon={project.icon}
      projectColor={project.color}
      projectIconImage={project.iconImage}
      projectIconBackground={project.iconBackground}
      isCollapsed={row.isCollapsed}
      isRepo={isRepo}
      isDesktopShell={props.isDesktopShellRuntime}
      hideDirectoryControls={props.hideDirectoryControls}
      mobileVariant={props.mobileVariant}
      alwaysShowActions={props.alwaysShowActions}
      openSidebarMenuKey={props.openSidebarMenuKey}
      setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
      statusIndicator={row.isCollapsed ? statusIndicator : null}
      projectPickerOptions={props.singleProjectMode ? props.projectPickerOptions : undefined}
      onProjectSelect={props.singleProjectMode ? props.setSingleProjectId : undefined}
      onToggle={() => props.toggleProject(project.id)}
      onNewSession={() => {
        if (project.id !== props.activeProjectId) props.setActiveProjectIdOnly(project.id);
        if (props.mobileVariant) props.setSessionSwitcherOpen(false);
        props.openNewSessionDraft({ selectedProjectId: project.id, directoryOverride: project.normalizedPath });
      }}
      onNewWorktreeSession={() => {
        if (project.id !== props.activeProjectId) props.setActiveProjectIdOnly(project.id);
        props.openNewWorktreeDialog();
      }}
      onManageWorktrees={() => props.openWorktreesPage(project.id)}
      onRenameStart={() => props.openProjectEditDialog(project.id)}
      onClose={() => props.removeProject(project.id)}
      sentinelRef={(element) => { props.projectHeaderSentinelRefs.current.set(project.id, element); }}
      showCreateButtons
    >
      {null}
    </SortableProjectItem>
  );
};

const SearchGroupHeader: React.FC<{
  row: SessionSearchGroupHeaderRow;
  props: SessionSearchRowsProps;
}> = ({ row, props }) => {
  const { t } = useI18n();
  const { group } = row;
  const groupPrKey = React.useMemo(() => {
    if (group.isMain || group.isArchivedBucket || row.hideGroupLabel) return null;
    const directory = normalizePath(group.directory ?? null);
    const branch = group.branch?.trim();
    return directory && branch ? getGitHubPrStatusKey(directory, branch) : null;
  }, [group.branch, group.directory, group.isArchivedBucket, group.isMain, row.hideGroupLabel]);
  const groupPrSummary = usePrVisualSummary(groupPrKey);
  const groupPrColor = groupPrSummary ? `var(--pr-${groupPrSummary.visualState})` : undefined;
  const worktreeMissingIndicator = group.worktree?.worktreeStatus === 'missing' ? (
    <span
      className="inline-flex flex-shrink-0 items-center text-status-warning"
      title={t('sessions.sidebar.group.worktreeMissing')}
      aria-label={t('sessions.sidebar.group.worktreeMissing')}
    >
      <Icon name="alert" className="h-3 w-3" />
    </span>
  ) : null;
  const hasWorktreeDeleteAction = Boolean(!group.isMain && group.worktree);
  const groupHeaderRightPadding = props.alwaysShowActions
    ? (hasWorktreeDeleteAction ? 'pr-14' : 'pr-7')
    : (hasWorktreeDeleteAction
        ? 'pr-2 group-hover/gh:pr-14 group-focus-within/gh:pr-14'
        : 'pr-2 group-hover/gh:pr-7 group-focus-within/gh:pr-7');
  const actionVisibilityClassName = props.alwaysShowActions
    ? 'opacity-100'
    : 'opacity-0 pointer-events-none group-hover/gh:opacity-100 group-hover/gh:pointer-events-auto group-focus-within/gh:opacity-100 group-focus-within/gh:pointer-events-auto';
  const showBranchSubtitle = !group.isMain && Boolean(group.branch);
  const statusLine = group.branch && isBranchDifferentFromLabel(group.branch, group.label)
    ? { label: group.branch }
    : null;
  return (
    <div className="oc-group">
      <div
        className="group/gh relative flex min-w-0 cursor-pointer items-start justify-between gap-1 rounded-md py-1"
        onClick={() => props.sessionProps.onToggleCollapsedGroup(row.groupKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            props.sessionProps.onToggleCollapsedGroup(row.groupKey);
          }
        }}
        aria-label={t('sessions.sidebar.group.collapseAria', { label: group.label })}
        aria-expanded={!row.isCollapsed}
      >
        <div className={cn('min-w-0 flex flex-1 items-start gap-1 overflow-hidden pl-1.5 transition-[padding]', groupHeaderRightPadding)}>
          <div className="min-w-0 flex flex-1 flex-col justify-center gap-0.5 overflow-hidden">
            <p className="typography-ui-label truncate font-normal text-foreground/92">
              {group.isArchivedBucket ? (
                <span className="inline-flex min-w-0 max-w-full items-center gap-1">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <Icon name="archive" className="h-3.5 w-3.5 shrink-0 text-muted-foreground group-hover/gh:hidden" />
                    <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover/gh:inline-flex">
                      <Icon name={row.isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
                    </span>
                  </span>
                  <span className="min-w-0 flex-1 truncate">{renderHighlightedText(group.label, props.sessionProps.normalizedSessionSearchQuery)}</span>
                  {worktreeMissingIndicator}
                </span>
              ) : (
                <span className="flex w-full min-w-0 items-center gap-1.5">
                  <span className="inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    <Icon
                      name="git-branch"
                      className={cn('h-3.5 w-3.5 shrink-0 group-hover/gh:hidden', !groupPrColor && 'text-muted-foreground')}
                      style={groupPrColor ? { color: groupPrColor } : undefined}
                    />
                    <span className="hidden h-3.5 w-3.5 items-center justify-center text-muted-foreground group-hover/gh:inline-flex">
                      <Icon name={row.isCollapsed ? 'arrow-right-s' : 'arrow-down-s'} className="h-3.5 w-3.5" />
                    </span>
                  </span>
                  <span className="min-w-0 truncate font-semibold text-muted-foreground">
                    {renderHighlightedText(group.label, props.sessionProps.normalizedSessionSearchQuery)}
                  </span>
                  {worktreeMissingIndicator}
                  {groupPrSummary ? (
                    <span className="ml-auto flex-shrink-0 text-[0.72rem] font-medium leading-none" style={groupPrColor ? { color: groupPrColor } : undefined}>
                      #{groupPrSummary.number}
                    </span>
                  ) : null}
                </span>
              )}
            </p>
            {showBranchSubtitle && statusLine ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 leading-tight">
                <Icon name={group.isArchivedBucket ? 'archive' : 'git-branch'} className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-[11px] font-medium text-muted-foreground/80">{statusLine.label}</span>
              </span>
            ) : null}
          </div>
          {!group.isArchivedBucket && group.directory ? <DirectoryActionIndicator directory={group.directory} className="self-center" /> : null}
        </div>
        {group.isArchivedBucket && row.allGroupSessions.length > 0 ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              sessionEvents.requestDelete({ sessions: [...row.allGroupSessions], mode: 'session' });
            }}
             className={cn('absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-interactive-hover/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', actionVisibilityClassName)}
            aria-label={t('sessions.sidebar.group.actions.deleteArchivedInGroupAria', { label: group.label })}
          >
            <Icon name="delete-bin" className="h-4 w-4" />
          </button>
        ) : null}
        {group.directory && !group.isMain && group.worktree ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              sessionEvents.requestDelete({ sessions: [...row.allGroupSessions], mode: 'worktree', worktree: group.worktree });
            }}
             className={cn('absolute right-7 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-interactive-hover/50 hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', actionVisibilityClassName)}
            aria-label={t('sessions.sidebar.group.actions.deleteGroupAria', { label: group.label })}
          >
            <Icon name="delete-bin" className="h-4 w-4" />
          </button>
        ) : null}
        {group.directory ? (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (row.projectId && row.projectId !== props.activeProjectId) props.setActiveProjectIdOnly(row.projectId);
              if (props.mobileVariant) props.setSessionSwitcherOpen(false);
              props.openNewSessionDraft({ selectedProjectId: row.projectId, directoryOverride: group.directory });
            }}
             className={cn('absolute right-0.5 top-1/2 z-10 inline-flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-opacity hover:bg-interactive-hover/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50', actionVisibilityClassName)}
            aria-label={t('sessions.sidebar.group.actions.newDraftInGroupAria', { label: group.label })}
          >
            <Icon name="add" className="h-4 w-4" />
          </button>
        ) : null}
      </div>
    </div>
  );
};

const SearchFolderRow: React.FC<{
  row: SessionSearchFolderRow;
  props: SessionSearchRowsProps;
}> = ({ row, props }) => {
  const toggleFolderCollapse = useSessionFoldersStore((state) => state.toggleFolderCollapse);
  const renameFolder = useSessionFoldersStore((state) => state.renameFolder);
  const deleteFolder = useSessionFoldersStore((state) => state.deleteFolder);
  const showDeletionDialog = useUIStore((state) => state.showDeletionDialog);
  const [deleteConfirm, setDeleteConfirm] = React.useState<DeleteFolderConfirmState>(null);
  const isRenaming = props.sessionProps.folderRename?.folderId === row.folder.id
    && props.sessionProps.folderRename.scopeKey === row.scopeKey;
  const handleDelete = React.useCallback(() => {
    if (row.archivedBucket) {
      sessionEvents.requestDelete({ sessions: [...row.deleteSessions], mode: 'session' });
      return;
    }
    if (!showDeletionDialog) {
      deleteFolder(row.scopeKey, row.folder.id);
      return;
    }
    setDeleteConfirm({
      scopeKey: row.scopeKey,
      folderId: row.folder.id,
      folderName: row.folder.name,
      subFolderCount: row.subFolderCount,
      sessionCount: row.nodes.length,
    });
  }, [deleteFolder, row, showDeletionDialog]);
  return (
    <>
      <DroppableFolderWrapper
        folderId={row.folder.id}
        scopeKey={row.scopeKey}
        ownerKey={row.folderOwnerKey}
      >
        {(droppableRef, isDropTarget) => (
          <SessionFolderItem
            folder={row.folder}
            displayName={row.displayName}
            sessions={row.nodes}
            isCollapsed={row.isCollapsed}
            renderBody={false}
            onToggle={() => toggleFolderCollapse(row.scopeKey, row.folder.id)}
            onRename={(name) => renameFolder(row.scopeKey, row.folder.id, name)}
            onDelete={handleDelete}
            groupDirectory={row.groupDirectory}
            projectId={row.projectId}
            mobileVariant={props.mobileVariant}
            alwaysShowActions={props.alwaysShowActions}
            isRenaming={isRenaming}
            renameDraft={isRenaming ? props.sessionProps.folderRename?.draft : undefined}
            onRenameDraftChange={props.sessionProps.setFolderRenameDraft}
            onRenameSave={() => {
              const trimmed = props.sessionProps.folderRename?.draft.trim() ?? '';
              if (trimmed) renameFolder(row.scopeKey, row.folder.id, trimmed);
              props.sessionProps.clearFolderRename();
            }}
            onRenameCancel={props.sessionProps.clearFolderRename}
            droppableRef={droppableRef}
            isDropTarget={isDropTarget}
            onNewSession={() => {
              if (row.projectId && row.projectId !== props.activeProjectId) props.setActiveProjectIdOnly(row.projectId);
              if (props.mobileVariant) props.setSessionSwitcherOpen(false);
              props.openNewSessionDraft({
                selectedProjectId: row.projectId,
                directoryOverride: row.groupDirectory,
                targetFolderId: row.folder.id,
                target: row.group.draftTarget,
              });
            }}
            hideActions={false}
            archivedBucket={row.archivedBucket}
          />
        )}
      </DroppableFolderWrapper>
      <FolderDeleteConfirmDialog
        value={deleteConfirm}
        setValue={setDeleteConfirm}
        onConfirm={() => {
          if (!deleteConfirm) return;
          deleteFolder(deleteConfirm.scopeKey, deleteConfirm.folderId);
          setDeleteConfirm(null);
        }}
      />
    </>
  );
};

const SearchSessionRow: React.FC<{
  row: SessionSearchSessionRow;
  props: SessionSearchRowsProps;
  renderExtras: SessionNodeRenderExtras;
  relativeTimeTick: number;
}> = ({ row, props, renderExtras, relativeTimeTick }) => (
  <SessionTreeItem
    node={row.node}
    depth={row.depth}
    pinnedSessionIds={props.sessionProps.pinnedSessionIds}
    expandedParents={props.sessionProps.expandedParents}
    hasSessionSearchQuery={props.sessionProps.hasSessionSearchQuery}
    normalizedSessionSearchQuery={props.sessionProps.normalizedSessionSearchQuery}
    notifyOnSubtasks={props.sessionProps.notifyOnSubtasks}
    editingId={props.sessionProps.editingId}
    editTitle={props.sessionProps.editTitle}
    copiedSessionId={props.sessionProps.copiedSessionId}
    openSidebarMenuKey={props.openSidebarMenuKey}
    mobileVariant={props.mobileVariant}
    alwaysShowActions={props.alwaysShowActions}
     groupDirectory={row.groupDirectory}
     projectId={row.projectId}
     folderOwnerKey={row.folderOwnerKey}
     selectionScopeKey={row.selectionScopeKey}
     archivedBucket={row.archivedBucket}
    secondaryMeta={row.secondaryMeta}
    renderContext={row.renderContext}
    rowKey={row.key}
    dragKey={row.key}
    renderChildren={false}
    renderExtras={row.renderContext === 'recent' ? { ...renderExtras, relativeTimeTick } : renderExtras}
    setEditingId={props.sessionProps.setEditingId}
    setEditTitle={props.sessionProps.setEditTitle}
    toggleParent={props.sessionProps.toggleParent}
    setOpenSidebarMenuKey={props.setOpenSidebarMenuKey}
    allowReselect={props.sessionProps.allowReselect}
    onSessionSelected={props.sessionProps.onSessionSelected}
    resetSessionSearch={props.sessionProps.resetSessionSearch}
    deleteSessionConfirm={props.sessionProps.deleteSessionConfirm}
    setDeleteSessionConfirm={props.sessionProps.setDeleteSessionConfirm}
    startFolderRename={props.sessionProps.startFolderRename}
    setCopiedSessionId={props.sessionProps.setCopiedSessionId}
    startSessionWorktreeMenuLoad={props.sessionProps.startSessionWorktreeMenuLoad}
  />
);

const SearchEmptyRow: React.FC<{ row: SessionSearchEmptyRow }> = ({ row }) => {
  const { t } = useI18n();
  return (
    <div className="py-1 pl-[26px] text-left typography-micro text-muted-foreground">
      {row.archivedBucket ? t('sessions.sidebar.group.empty.noArchivedSessions') : row.group.emptyMessage ?? t('sessions.sidebar.group.empty.noSessionsInWorkspace')}
    </div>
  );
};

const buildSearchRenderExtras = (
  rows: readonly SessionSearchRow[],
  editingId: string | null,
  openSidebarMenuKey: string | null,
): WeakMap<SessionNode, SessionNodeRenderExtras> => {
  const nodes: SessionNode[] = [];
  const seenNodes = new WeakSet<SessionNode>();
  rows.forEach((row) => {
    if (row.kind !== 'session' || seenNodes.has(row.node)) return;
    seenNodes.add(row.node);
    nodes.push(row.node);
  });
  const childIds = new Set<string>();
  const structureKeys = new WeakMap<SessionNode, string>();
  const visitStructure = (node: SessionNode): void => {
    if (structureKeys.has(node)) return;
    structureKeys.set(node, computeNodeStructureKey(node));
    node.children.forEach((child) => {
      childIds.add(child.session.id);
      visitStructure(child);
    });
  };
  nodes.forEach(visitStructure);
  const roots = nodes.filter((node) => !childIds.has(node.session.id));
  const subtreeContainsEditing = new Set<string>();
  collectSubtreeContainingId(roots, editingId, subtreeContainsEditing);
  let menuOpenSessionId: string | null = null;
  for (const row of rows) {
    if (row.kind !== 'session') continue;
    const candidate = resolveMenuOpenSessionId([row.node], openSidebarMenuKey, row.renderContext, row.archivedBucket);
    if (candidate) {
      menuOpenSessionId = candidate;
      break;
    }
  }
  const extrasByNode = new WeakMap<SessionNode, SessionNodeRenderExtras>();
  nodes.forEach((node) => {
    extrasByNode.set(node, {
      subtreeContainsEditing,
      menuOpenSessionId,
      nodeStructureKey: structureKeys.get(node) ?? '',
    });
  });
  return extrasByNode;
};

export const SessionSearchRows: React.FC<SessionSearchRowsProps> = (props) => {
  const { model, onRowsMounted, scrollContainerRef } = props;
  const contentRef = React.useRef<HTMLDivElement | null>(null);
  const [scrollElement, setScrollElement] = React.useState<HTMLElement | null>(null);
  const [relativeTimeTick, setRelativeTimeTick] = React.useState(0);
  const hasRecentRows = model.rows.some((row) => row.kind === 'session' && row.renderContext === 'recent');
  React.useLayoutEffect(() => {
    const content = contentRef.current;
    const threadedScrollElement = scrollContainerRef.current;
    const nextScrollElement = threadedScrollElement && (!content || threadedScrollElement.contains(content))
      ? threadedScrollElement
      : findSearchScrollElement(content);
    setScrollElement((current) => current === nextScrollElement ? current : nextScrollElement);
  }, [scrollContainerRef, scrollElement]);
  React.useLayoutEffect(() => {
    if (scrollElement) onRowsMounted?.();
  }, [onRowsMounted, scrollElement]);
  React.useEffect(() => {
    if (!hasRecentRows) return;
    const timer = window.setInterval(() => setRelativeTimeTick((value) => value + 1), 60_000);
    return () => window.clearInterval(timer);
  }, [hasRecentRows]);
  const renderExtras = React.useMemo(
    () => buildSearchRenderExtras(model.rows, props.sessionProps.editingId, props.openSidebarMenuKey),
    [model.rows, props.openSidebarMenuKey, props.sessionProps.editingId],
  );
  useRegisterSessionRowOrder(0, model.entries);
  const virtualizer = useVirtualizer<HTMLElement, HTMLDivElement>({
    count: model.rows.length,
    enabled: scrollElement !== null,
    getScrollElement: () => scrollElement,
    initialOffset: () => scrollElement?.scrollTop ?? 0,
    estimateSize: () => ROW_ESTIMATE_PX,
    overscan: 8,
    getItemKey: (index) => model.rows[index]?.key ?? index,
  });
  const visibleRows = virtualizer.getVirtualItems();
  const rowsToRender = scrollElement ? visibleRows : [];
  const folderRows = model.rows.filter((row): row is SessionSearchFolderRow => row.kind === 'folder');

  const handleSessionDroppedOnFolder = React.useCallback((sessionId: string, target: SessionFolderDropTarget, sourceOwnerKey: string) => {
    if (sourceOwnerKey !== target.ownerKey) return;
    const targetRows = folderRows.filter((row) => (
      row.scopeKey === target.scopeKey
      && row.folder.id === target.folderId
      && row.folderOwnerKey === target.ownerKey
    ));
    if (targetRows.length !== 1) return;
     const targetRow = targetRows[0];
     if (!targetRow) return;
     const foldersStore = useSessionFoldersStore.getState();
     const currentTargetFolders = foldersStore.foldersMap[targetRow.scopeKey] ?? [];
     if (currentTargetFolders.filter((folder) => folder.id === targetRow.folder.id).length !== 1) return;
     const ownerScopeKeys = new Set<string>();
     model.projectSections.forEach((section) => {
       section.groups.forEach((group) => {
         if (getSessionFolderOwnerKey(section.project.id, group.directory) !== target.ownerKey) return;
         getSessionFolderScopes(group).forEach(({ scopeKey }) => ownerScopeKeys.add(scopeKey));
       });
     });
    folderRows.forEach((row) => {
      if (row.folderOwnerKey !== target.ownerKey) return;
      getSessionFolderScopes(row.group).forEach(({ scopeKey }) => ownerScopeKeys.add(scopeKey));
    });
    if (ownerScopeKeys.size === 0) ownerScopeKeys.add(target.scopeKey);
    for (const scopeKey of ownerScopeKeys) {
      if (scopeKey === target.scopeKey) continue;
      if (foldersStore.getSessionFolderId(scopeKey, sessionId)) {
        foldersStore.removeSessionFromFolder(scopeKey, sessionId);
      }
    }
    foldersStore.addSessionToFolder(targetRow.scopeKey, targetRow.folder.id, sessionId);
  }, [folderRows, model.projectSections]);

  const renderRow = React.useCallback((row: SessionSearchRow): React.ReactNode => {
    switch (row.kind) {
      case 'activity-header':
        return (
          <SearchActivityHeader
            row={row}
            collapsed={row.isCollapsed}
            onToggle={() => props.toggleActivitySection(row.activityKey)}
            onNewChat={props.onNewChat}
            alwaysShowActions={props.alwaysShowActions}
            stickyZoneHeaders={props.stickyZoneHeaders}
          />
        );
      case 'project-header': {
        const section = model.projectSections.find((candidate) => candidate.project.id === row.project.id);
        return <SearchProjectHeader row={row} props={props} statusIndicator={section ? props.renderProjectStatusIndicator?.(row.project.id, section.groups) : null} />;
      }
      case 'group-header':
        return <SearchGroupHeader row={row} props={props} />;
      case 'folder':
        return <SearchFolderRow row={row} props={props} />;
      case 'session':
        return <SearchSessionRow row={row} props={props} renderExtras={renderExtras.get(row.node) ?? EMPTY_SESSION_RENDER_EXTRAS} relativeTimeTick={relativeTimeTick} />;
      case 'empty-group':
        return <SearchEmptyRow row={row} />;
    }
  }, [model.projectSections, props, relativeTimeTick, renderExtras]);

  const totalSize = scrollElement ? virtualizer.getTotalSize() : model.rows.length * ROW_ESTIMATE_PX;
  const content = (
    <div ref={contentRef} data-session-search-virtual-content style={{ height: totalSize, position: 'relative' }}>
      {rowsToRender.map((item) => {
        const row = model.rows[item.index];
        if (!row) return null;
        return (
          <div
            key={item.key}
            data-index={item.index}
            ref={scrollElement ? virtualizer.measureElement : undefined}
            className="[&_[data-session-row]]:my-px"
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              transform: `translateY(${item.start}px)`,
            }}
          >
            {renderRow(row)}
          </div>
        );
      })}
    </div>
  );

  return (
    <SessionFolderDndScope
      scopeKey="search"
      hasFolders={folderRows.length > 0}
      onSessionDroppedOnFolder={handleSessionDroppedOnFolder}
    >
      {content}
    </SessionFolderDndScope>
  );
};
