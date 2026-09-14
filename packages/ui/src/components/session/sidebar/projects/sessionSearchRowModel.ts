import type { Session } from '@opencode-ai/sdk/v2';
import { getRuntimeKey } from '@/lib/runtime-switch';
import type { SessionFolder, SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import { getPinnedSessionKey } from '@/stores/useSessionPinnedStore';
import type {
  GroupSearchData,
  SessionGroup,
  SessionNode,
} from '../types';
import type { ProjectSection } from './sessionProjectRender';
import { buildGroupRenderDescriptors } from './sessionProjectRender';
import {
  normalizeFolderRoots,
  selectFolderIdsForProjection,
  selectFolderRootNodes,
} from '../sessions/sessionNodeItemUtils';
import {
  getSessionFolderIdentityKey,
  getSessionFolderOwnerKey,
  getSessionFolderScopes,
} from '../sessions/sessionFolderIdentity';
import { normalizePath } from '../utils';
import type { SessionRowOrderEntry } from '../sessions/sessionRowOrderUtils';

export type SessionSearchActivityItem = {
  node: SessionNode;
  projectId: string | null;
  groupDirectory: string | null;
  selectionScopeKey?: string | null;
  secondaryMeta: {
    projectLabel?: string | null;
    branchLabel?: string | null;
  } | null;
};

export type SessionSearchActivitySection = {
  key: 'active-now';
  items: readonly SessionSearchActivityItem[];
};

type SessionSearchRowCommon = {
  key: string;
};

export type SessionSearchActivityHeaderRow = SessionSearchRowCommon & {
  kind: 'activity-header';
  activityKey: 'chats' | 'active-now';
  showNewChat: boolean;
  isCollapsed: boolean;
};

export type SessionSearchProjectHeaderRow = SessionSearchRowCommon & {
  kind: 'project-header';
  project: ProjectSection['project'];
  isCollapsed: boolean;
};

export type SessionSearchGroupHeaderRow = SessionSearchRowCommon & {
  kind: 'group-header';
  group: SessionGroup;
  groupKey: string;
  projectId: string | null;
  hideGroupLabel: boolean;
  isCollapsed: boolean;
  allGroupSessions: readonly Session[];
};

export type SessionSearchFolderRow = SessionSearchRowCommon & {
  kind: 'folder';
  folder: SessionFolder;
  group: SessionGroup;
  displayName: string;
  scopeKey: string;
  scopeDirectory: string | null;
  folderOwnerKey: string | null;
  nodes: readonly SessionNode[];
  projectId: string | null;
  groupDirectory: string | null;
  archivedBucket: boolean;
  isCollapsed: boolean;
  deleteSessions: readonly Session[];
  subFolderCount: number;
};

export type SessionSearchSessionRow = SessionSearchRowCommon & {
  kind: 'session';
  node: SessionNode;
  depth: number;
  projectId: string | null;
  groupDirectory: string | null;
  folderOwnerKey: string | null;
  selectionScopeKey?: string | null;
  archivedBucket: boolean;
  renderContext: 'project' | 'recent';
  secondaryMeta?: SessionSearchActivityItem['secondaryMeta'];
};

export type SessionSearchEmptyRow = SessionSearchRowCommon & {
  kind: 'empty-group';
  group: SessionGroup;
  archivedBucket: boolean;
};

export type SessionSearchRow =
  | SessionSearchActivityHeaderRow
  | SessionSearchProjectHeaderRow
  | SessionSearchGroupHeaderRow
  | SessionSearchFolderRow
  | SessionSearchSessionRow
  | SessionSearchEmptyRow;

export type SessionSearchRowModel = {
  rows: readonly SessionSearchRow[];
  entries: readonly SessionRowOrderEntry[];
  projectSections: readonly ProjectSection[];
  hasResults: boolean;
  /** True when the expanded Recent projection contributes session rows. */
  hasRecentRows: boolean;
  /** The folder rows in `rows`, retained for search DnD without a render scan. */
  folderRows: readonly SessionSearchFolderRow[];
  /** Number of unique session ids in the final rendered projection. */
  searchMatchCount: number;
};

type SearchFolderEntry = {
  folder: SessionFolder;
  scopeKey: string;
  scopeDirectory: string | null;
  nodes: SessionNode[];
  folderOwnerKey: string | null;
};

type SearchGroupProjection = {
  sourceNodes: SessionNode[];
  folders: SearchFolderEntry[];
  rootFolders: SearchFolderEntry[];
  childFoldersByParentId: ReadonlyMap<string, readonly SearchFolderEntry[]>;
  ungroupedNodes: SessionNode[];
};

export type SessionSearchRowModelArgs = {
  sections: readonly ProjectSection[];
  chatGroup: SessionGroup | null;
  groupSearchDataByGroup: WeakMap<SessionGroup, GroupSearchData>;
  foldersMap: SessionFoldersMap;
  normalizedQuery: string;
  collapsedProjects: ReadonlySet<string>;
  collapsedActivitySections: ReadonlySet<'chats' | 'active-now'>;
  showOnlyMainWorkspace: boolean;
  activeProjectId: string | null;
  singleProjectMode: boolean;
  singleProjectId: string | null;
  showRecentSection: boolean;
  recentSections: readonly SessionSearchActivitySection[];
  pinnedSessionIds: ReadonlySet<string>;
  sessionOrderIndex: ReadonlyMap<string, number>;
};

type AppendSessionOptions = {
  containerKey: string;
  nodes: readonly SessionNode[];
  projectId: string | null;
  groupDirectory: string | null;
  folderOwnerKey: string | null;
  selectionScopeKey?: string | null;
  archivedBucket: boolean;
  renderContext: 'project' | 'recent';
  secondaryMeta?: SessionSearchActivityItem['secondaryMeta'];
  rows: SessionSearchRow[];
  entries: SessionRowOrderEntry[];
};

const EMPTY_FOLDERS: readonly SessionFolder[] = [];

const countRenderedSessions = (rows: readonly SessionSearchRow[], normalizedQuery: string): number => {
  const query = normalizedQuery.trim().toLowerCase();
  const isIdQuery = query.startsWith('ses_');
  const sessionIds = new Set<string>();
  rows.forEach((row) => {
    if (row.kind !== 'session') return;
    if (isIdQuery && row.node.session.id.toLowerCase() !== query) return;
    sessionIds.add(row.node.session.id);
  });
  return sessionIds.size;
};

const isNodePinned = (
  node: SessionNode,
  fallbackDirectory: string | null,
  pinnedSessionIds: ReadonlySet<string>,
  runtimeKey: string,
): boolean => {
  const directory = normalizePath(node.session.directory ?? null) ?? normalizePath(fallbackDirectory ?? null);
  const key = directory ? getPinnedSessionKey(runtimeKey, directory, node.session.id) : null;
  return key ? pinnedSessionIds.has(key) : false;
};

const compareNodes = (
  a: SessionNode,
  b: SessionNode,
  pinnedSessionIds: ReadonlySet<string>,
  sessionOrderIndex: ReadonlyMap<string, number>,
  fallbackDirectory: string | null,
  runtimeKey: string,
): number => {
  const aIndex = sessionOrderIndex.get(a.session.id);
  const bIndex = sessionOrderIndex.get(b.session.id);
  if (aIndex !== undefined || bIndex !== undefined) {
    if (aIndex === undefined) return 1;
    if (bIndex === undefined) return -1;
    if (aIndex !== bIndex) return aIndex - bIndex;
  }

  // The grouped data is already lifecycle ordered. This stable tie breaker is
  // enough for search projection work and keeps a pinned replacement in the
  // same order as the existing sidebar rows.
  const aPinned = isNodePinned(a, fallbackDirectory, pinnedSessionIds, runtimeKey);
  const bPinned = isNodePinned(b, fallbackDirectory, pinnedSessionIds, runtimeKey);
  if (aPinned !== bPinned) return aPinned ? -1 : 1;
  return 0;
};

const collectNodesById = (nodes: readonly SessionNode[]): Map<string, SessionNode> => {
  const result = new Map<string, SessionNode>();
  const visit = (node: SessionNode): void => {
    result.set(node.session.id, node);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return result;
};

const projectGroup = (
  group: SessionGroup,
  projectId: string | null,
  searchData: GroupSearchData | undefined,
  foldersMap: SessionFoldersMap,
  normalizedQuery: string,
  pinnedSessionIds: ReadonlySet<string>,
  sessionOrderIndex: ReadonlyMap<string, number>,
): SearchGroupProjection => {
  const folderOwnerKey = getSessionFolderOwnerKey(projectId, group.directory);
  const runtimeKey = getRuntimeKey();
  const sourceNodes = [...(searchData?.filteredNodes ?? [])]
    .sort((a, b) => compareNodes(a, b, pinnedSessionIds, sessionOrderIndex, group.directory, runtimeKey));
  const nodeBySessionId = collectNodesById(sourceNodes);
  const folderEntriesBase = getSessionFolderScopes(group).flatMap(({ scopeKey, directory }) => {
    const folders = foldersMap[scopeKey] ?? EMPTY_FOLDERS;
    return folders.map((folder) => ({
      folder,
      scopeKey,
      scopeDirectory: directory,
      folderOwnerKey,
      nodes: selectFolderRootNodes(folder.sessionIds, nodeBySessionId)
        .sort((a, b) => compareNodes(a, b, pinnedSessionIds, sessionOrderIndex, directory, runtimeKey)),
    }));
  });
  const visibleFolderKeys = selectFolderIdsForProjection(
    folderEntriesBase.map(({ folder, scopeKey, nodes }) => ({
      id: folder.id,
      scopeKey,
      name: folder.name,
      parentId: folder.parentId,
      nodeCount: nodes.length,
    })),
    {
      archivedBucket: group.isArchivedBucket === true,
      searchQuery: normalizedQuery,
    },
  );
  const folders = folderEntriesBase.filter(({ folder, scopeKey }) => (
    visibleFolderKeys.has(getSessionFolderIdentityKey(scopeKey, folder.id))
  ));
  const entryByKey = new Map(folders.map((entry) => [
    getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id),
    entry,
  ]));
  const rootFolders = normalizeFolderRoots(folders.map(({ folder, scopeKey }) => ({ ...folder, scopeKey })))
    .map((folder) => entryByKey.get(getSessionFolderIdentityKey(folder.scopeKey ?? '', folder.id)))
    .filter((entry): entry is SearchFolderEntry => Boolean(entry));
  const childFoldersByParentId = new Map<string, SearchFolderEntry[]>();
  folders.forEach((entry) => {
    const parentId = entry.folder.parentId;
    if (!parentId) return;
    const parentKey = getSessionFolderIdentityKey(entry.scopeKey, parentId);
    const children = childFoldersByParentId.get(parentKey) ?? [];
    children.push(entry);
    childFoldersByParentId.set(parentKey, children);
  });
  const sessionIdsInFolders = new Set(folders.flatMap(({ folder }) => folder.sessionIds));

  return {
    sourceNodes,
    folders,
    rootFolders,
    childFoldersByParentId,
    ungroupedNodes: sourceNodes.filter((node) => !sessionIdsInFolders.has(node.session.id)),
  };
};

const appendSessionRows = (options: AppendSessionOptions): void => {
  const occurrences = new Map<string, number>();
  const visit = (
    node: SessionNode,
    inheritedDirectory: string | null,
    depth: number,
    path: readonly string[],
    rowGroupDirectory: string | null,
    secondaryMeta: SessionSearchActivityItem['secondaryMeta'],
  ): void => {
    const pathKey = path.join('/');
    const baseKey = `${options.containerKey}:session:${pathKey}`;
    const occurrence = occurrences.get(baseKey) ?? 0;
    occurrences.set(baseKey, occurrence + 1);
    const key = occurrence === 0 ? baseKey : `${baseKey}:${occurrence}`;
    const scopeKey = options.selectionScopeKey !== undefined
      ? options.selectionScopeKey
      : getSessionFolderOwnerKey(options.projectId, options.groupDirectory)
        ?? normalizePath(node.session.directory ?? null)
        ?? normalizePath(inheritedDirectory);
    options.rows.push({
      kind: 'session',
      key,
      node,
      depth,
      projectId: options.projectId,
      groupDirectory: rowGroupDirectory,
      folderOwnerKey: options.folderOwnerKey,
      selectionScopeKey: scopeKey,
      archivedBucket: options.archivedBucket,
      renderContext: options.renderContext,
      secondaryMeta,
    });
    options.entries.push({ id: node.session.id, rowKey: key, scopeKey, archived: options.archivedBucket });

    const childDirectory = node.session.directory ?? inheritedDirectory;
    node.children.forEach((child) => visit(
      child,
      childDirectory,
      depth + 1,
      [...path, child.session.id],
      childDirectory,
      null,
    ));
  };

  options.nodes.forEach((node) => visit(
    node,
    options.groupDirectory,
    0,
    [node.session.id],
    options.groupDirectory,
    options.secondaryMeta ?? null,
  ));
};

const appendGroupBody = ({
  group,
  groupKey,
  projectId,
  projection,
  rows,
  entries,
  folderRows,
}: {
  group: SessionGroup;
  groupKey: string;
  projectId: string | null;
  projection: SearchGroupProjection;
  rows: SessionSearchRow[];
  entries: SessionRowOrderEntry[];
  folderRows: SessionSearchFolderRow[];
}): boolean => {
  const visitedFolders = new Set<string>();
  const selectionScopeKey = getSessionFolderOwnerKey(projectId, group.directory);
  const foldersByKey = new Map(projection.folders.map((entry) => [
    getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id),
    entry,
  ]));
  const collectNodeSessions = (nodes: readonly SessionNode[], out: Session[]): void => {
    nodes.forEach((node) => {
      out.push(node.session);
      collectNodeSessions(node.children, out);
    });
  };
  const collectFolderSessions = (folderKey: string, seen: Set<string>): Session[] => {
    if (seen.has(folderKey)) return [];
    seen.add(folderKey);
    const sessions: Session[] = [];
    const entry = foldersByKey.get(folderKey);
    if (entry) collectNodeSessions(entry.nodes, sessions);
    (projection.childFoldersByParentId.get(folderKey) ?? []).forEach((child) => {
      sessions.push(...collectFolderSessions(getSessionFolderIdentityKey(child.scopeKey, child.folder.id), seen));
    });
    return sessions;
  };
  let hasBody = false;
  const visitFolder = (entry: SearchFolderEntry, parentPath: string): void => {
    const entryKey = getSessionFolderIdentityKey(entry.scopeKey, entry.folder.id);
    if (visitedFolders.has(entryKey)) return;
    visitedFolders.add(entryKey);
    const displayName = parentPath ? `${parentPath} / ${entry.folder.name}` : entry.folder.name;
    const folderKey = `${groupKey}:folder:${entryKey}`;
    const isCollapsed = false;
    const folderRow: SessionSearchFolderRow = {
      kind: 'folder',
      key: folderKey,
      folder: entry.folder,
      group,
      displayName,
      scopeKey: entry.scopeKey,
      scopeDirectory: entry.scopeDirectory,
      folderOwnerKey: entry.folderOwnerKey,
      nodes: entry.nodes,
      projectId,
      groupDirectory: entry.scopeDirectory ?? group.directory,
      archivedBucket: group.isArchivedBucket === true,
      isCollapsed,
      deleteSessions: collectFolderSessions(entryKey, new Set()),
      subFolderCount: projection.childFoldersByParentId.get(entryKey)?.length ?? 0,
    };
    rows.push(folderRow);
    folderRows.push(folderRow);
    hasBody = true;
    if (isCollapsed) return;
    appendSessionRows({
      containerKey: folderKey,
      nodes: entry.nodes,
      projectId,
      groupDirectory: entry.scopeDirectory ?? group.directory,
      folderOwnerKey: entry.folderOwnerKey,
      selectionScopeKey,
      archivedBucket: group.isArchivedBucket === true,
      renderContext: 'project',
      rows,
      entries,
    });
    (projection.childFoldersByParentId.get(entryKey) ?? []).forEach((child) => visitFolder(child, displayName));
  };

  projection.rootFolders.forEach((entry) => visitFolder(entry, ''));
  if (projection.ungroupedNodes.length > 0) {
    hasBody = true;
    appendSessionRows({
      containerKey: groupKey,
      nodes: projection.ungroupedNodes,
      projectId,
      groupDirectory: group.directory,
      folderOwnerKey: getSessionFolderOwnerKey(projectId, group.directory),
      selectionScopeKey,
      archivedBucket: group.isArchivedBucket === true,
      renderContext: 'project',
      rows,
      entries,
    });
  }
  return hasBody;
};

const appendGroup = ({
  group,
  groupKey,
  projectId,
  hideGroupLabel,
  collapsed,
  args,
  rows,
  entries,
  folderRows,
}: {
  group: SessionGroup;
  groupKey: string;
  projectId: string | null;
  hideGroupLabel: boolean;
  collapsed: boolean;
  args: SessionSearchRowModelArgs;
  rows: SessionSearchRow[];
  entries: SessionRowOrderEntry[];
  folderRows: SessionSearchFolderRow[];
}): void => {
  const projection = projectGroup(
    group,
    projectId,
    args.groupSearchDataByGroup.get(group),
    args.foldersMap,
    args.normalizedQuery,
    args.pinnedSessionIds,
    args.sessionOrderIndex,
  );
  const allGroupSessions: Session[] = [];
  const collect = (nodes: readonly SessionNode[]): void => {
    nodes.forEach((node) => {
      allGroupSessions.push(node.session);
      collect(node.children);
    });
  };
  collect(projection.sourceNodes);

  if (!hideGroupLabel) {
    rows.push({
      kind: 'group-header',
      key: `${groupKey}:header`,
      group,
      groupKey,
      projectId,
      hideGroupLabel,
      isCollapsed: collapsed,
      allGroupSessions,
    });
  }
  if (collapsed) return;

  const hasBody = appendGroupBody({
    group,
    groupKey,
    projectId,
    projection,
    rows,
    entries,
    folderRows,
  });
  if (!hasBody) {
    rows.push({
      kind: 'empty-group',
      key: `${groupKey}:empty`,
      group,
      archivedBucket: group.isArchivedBucket === true,
    });
  }
};

const appendProject = (
  section: ProjectSection,
  args: SessionSearchRowModelArgs,
  rows: SessionSearchRow[],
  entries: SessionRowOrderEntry[],
  folderRows: SessionSearchFolderRow[],
): void => {
  const projectId = section.project.id;
  const isCollapsed = !args.singleProjectMode && !args.showOnlyMainWorkspace
    && args.collapsedProjects.has(projectId);
  if (!args.showOnlyMainWorkspace) {
    rows.push({
      kind: 'project-header',
      key: `project:${projectId}:header`,
      project: section.project,
      isCollapsed,
    });
  }
  if (isCollapsed) return;

  const groups = section.groups;
  const rootGroup = groups.find((group) => group.isMain) ?? null;
  const descriptors = args.showOnlyMainWorkspace
    ? buildGroupRenderDescriptors(section, { mainWorkspaceOnly: true })
    : [
      ...(rootGroup ? [{ group: rootGroup, groupKey: `${projectId}:${rootGroup.id}`, projectId, hideGroupLabel: true }] : []),
      ...groups
        .filter((group) => group !== rootGroup)
        .map((group) => ({ group, groupKey: `${projectId}:${group.id}`, projectId, hideGroupLabel: false })),
    ];

  descriptors.forEach(({ group, groupKey, hideGroupLabel }) => appendGroup({
    group,
    groupKey,
    projectId,
    hideGroupLabel,
    collapsed: false,
    args,
    rows,
    entries,
    folderRows,
  }));
};

const appendChatGroup = (
  group: SessionGroup,
  args: SessionSearchRowModelArgs,
  rows: SessionSearchRow[],
  entries: SessionRowOrderEntry[],
  folderRows: SessionSearchFolderRow[],
): void => {
  const projection = projectGroup(
    group,
    null,
    args.groupSearchDataByGroup.get(group),
    args.foldersMap,
    args.normalizedQuery,
    args.pinnedSessionIds,
    args.sessionOrderIndex,
  );
  const groupKey = 'activity:chats';
  const hasBody = appendGroupBody({
    group,
    groupKey,
    projectId: null,
    projection,
    rows,
    entries,
    folderRows,
  });
  if (!hasBody) {
    rows.push({
      kind: 'empty-group',
      key: `${groupKey}:empty`,
      group,
      archivedBucket: false,
    });
  }
};

export const buildSessionSearchRowModel = (args: SessionSearchRowModelArgs): SessionSearchRowModel => {
  const rows: SessionSearchRow[] = [];
  const entries: SessionRowOrderEntry[] = [];
  const folderRows: SessionSearchFolderRow[] = [];
  const projectSections = args.singleProjectMode
    ? args.sections.filter((section) => section.project.id === args.singleProjectId)
    : args.sections;
  const chatSearchData = args.chatGroup ? args.groupSearchDataByGroup.get(args.chatGroup) : undefined;
  const hasProjectResults = projectSections.length > 0;
  const hasRecentResults = args.showRecentSection && args.recentSections.some((section) => section.items.length > 0);
  const hasRecentRows = hasRecentResults && !args.collapsedActivitySections.has('active-now');
  const hasChatResults = chatSearchData?.hasMatch === true;
  const hasResults = hasProjectResults || hasRecentResults || hasChatResults;
  if (!hasResults) {
    return { rows, entries, projectSections, hasResults: false, hasRecentRows, folderRows, searchMatchCount: 0 };
  }

  if (args.chatGroup) {
    rows.push({
      kind: 'activity-header',
      key: 'activity:chats:header',
      activityKey: 'chats',
      showNewChat: true,
      isCollapsed: args.collapsedActivitySections.has('chats'),
    });
    if (!args.collapsedActivitySections.has('chats') && hasChatResults) {
       appendChatGroup(args.chatGroup, args, rows, entries, folderRows);
    }
  }

  if (args.showRecentSection) {
    args.recentSections.forEach((section) => {
      if (section.items.length === 0) return;
      const isCollapsed = args.collapsedActivitySections.has('active-now');
      rows.push({
        kind: 'activity-header',
        key: `activity:${section.key}:header`,
        activityKey: 'active-now',
        showNewChat: false,
        isCollapsed,
      });
      if (isCollapsed) return;
      const recentOccurrences = new Map<string, number>();
      section.items.forEach((item) => {
        const occurrence = recentOccurrences.get(item.node.session.id) ?? 0;
        recentOccurrences.set(item.node.session.id, occurrence + 1);
        appendSessionRows({
          containerKey: `activity:${section.key}:${item.node.session.id}:${occurrence}`,
          nodes: [item.node],
           projectId: item.projectId,
           groupDirectory: item.groupDirectory,
           folderOwnerKey: getSessionFolderOwnerKey(item.projectId, item.groupDirectory),
           selectionScopeKey: item.selectionScopeKey ?? getSessionFolderOwnerKey(item.projectId, item.groupDirectory),
           archivedBucket: false,
          renderContext: 'recent',
          secondaryMeta: item.secondaryMeta,
           rows,
           entries,
          });
      });
    });
  }

  if (args.showOnlyMainWorkspace) {
    const activeSection = projectSections.find((section) => section.project.id === args.activeProjectId) ?? projectSections[0];
    if (activeSection) appendProject(activeSection, args, rows, entries, folderRows);
  } else {
    projectSections.forEach((section) => appendProject(section, args, rows, entries, folderRows));
  }

  return {
    rows,
    entries,
    projectSections,
    hasResults: rows.length > 0,
    hasRecentRows,
    folderRows,
    searchMatchCount: countRenderedSessions(rows, args.normalizedQuery),
  };
};
