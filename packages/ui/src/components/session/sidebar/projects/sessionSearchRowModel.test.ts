import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import type { SessionFoldersMap } from '@/stores/useSessionFoldersStore';
import type { GroupSearchData, SessionGroup, SessionNode } from '../types';
import { buildSessionSearchRowModel, type SessionSearchRowModelArgs } from './sessionSearchRowModel';

const PROJECT_ROOT = '/repo/project';
const WORKTREE_ROOT = '/repo/project-worktree';

const makeSession = (id: string, title = id, directory = PROJECT_ROOT): Session => ({
  id,
  slug: id,
  projectID: 'project',
  title,
  version: '1',
  directory,
  time: { created: 1, updated: 1 },
});

const makeNode = (session: Session, children: SessionNode[] = []): SessionNode => ({
  session,
  children,
  worktree: null,
});

const makeGroup = (id: string, nodes: SessionNode[], overrides: Partial<SessionGroup> = {}): SessionGroup => ({
  id,
  label: id,
  branch: null,
  description: null,
  isMain: id === 'main',
  worktree: null,
  directory: PROJECT_ROOT,
  folderScopeKey: PROJECT_ROOT,
  sessions: nodes,
  ...overrides,
});

const makeProjectSection = (groups: SessionGroup[]) => ({
  project: { id: 'project', path: PROJECT_ROOT, normalizedPath: PROJECT_ROOT },
  groups,
});

const searchDataFor = (group: SessionGroup): WeakMap<SessionGroup, GroupSearchData> => new WeakMap([[group, {
  filteredNodes: group.sessions,
  matchedSessionCount: group.sessions.length,
  folderNameMatchCount: 0,
  groupMatches: false,
  hasMatch: true,
}]]);

const baseArgs = (): Omit<SessionSearchRowModelArgs, 'sections' | 'groupSearchDataByGroup' | 'chatGroup'> => ({
  foldersMap: {} satisfies SessionFoldersMap,
  normalizedQuery: 'release',
  collapsedProjects: new Set(),
  collapsedActivitySections: new Set(),
  showOnlyMainWorkspace: false,
  activeProjectId: null,
  singleProjectMode: false,
  singleProjectId: null,
  showRecentSection: false,
  recentSections: [],
  pinnedSessionIds: new Set(),
  sessionOrderIndex: new Map(),
});

describe('buildSessionSearchRowModel', () => {
  test('keeps every matched session in one ordered model without a result cap', () => {
    const nodes = Array.from({ length: 250 }, (_, index) => makeNode(makeSession(`ses_${index}`, `Release ${index}`)));
    const group = makeGroup('main', nodes);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: searchDataFor(group),
    });

    const sessionRows = model.rows.filter((row) => row.kind === 'session');
    expect(sessionRows).toHaveLength(250);
    expect(model.searchMatchCount).toBe(250);
    expect(model.entries.map((entry) => entry.id)).toEqual(nodes.map((node) => node.session.id));
    expect(model.rows.some((row) => row.kind === 'project-header')).toBe(true);
  });

  test('does not count an ancestor that is rendered only as exact-id search context', () => {
    const child = makeNode(makeSession('ses_child', 'Release child'));
    const parent = makeNode(makeSession('ses_parent', 'Unrelated parent'), [child]);
    const group = makeGroup('main', [parent]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      normalizedQuery: 'ses_child',
      sections: [makeProjectSection([group])],
      chatGroup: null,
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [parent],
        matchedSessionCount: 1,
        folderNameMatchCount: 0,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual([
      'ses_parent',
      'ses_child',
    ]);
    expect(model.searchMatchCount).toBe(1);
  });

  test('flattens folder subtrees before ungrouped sessions and preserves row-order entries', () => {
    const parent = makeNode(makeSession('ses_parent', 'Release parent'));
    const child = makeNode(makeSession('ses_child', 'Release child'));
    const ungrouped = makeNode(makeSession('ses_ungrouped', 'Release ungrouped'));
    const folder = { id: 'folder-parent', name: 'Parent', sessionIds: ['ses_parent'], createdAt: 1 };
    const childFolder = { id: 'folder-child', name: 'Child', parentId: 'folder-parent', sessionIds: ['ses_child'], createdAt: 2 };
    const group = makeGroup('main', [parent, child, ungrouped]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: { [PROJECT_ROOT]: [folder, childFolder] },
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.map((row) => row.kind === 'folder' ? row.displayName : row.kind === 'session' ? row.node.session.id : row.kind)).toEqual([
      'project-header',
      'Parent',
      'ses_parent',
      'Parent / Child',
      'ses_child',
      'ses_ungrouped',
    ]);
    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => row.displayName)).toEqual(['Parent', 'Parent / Child']);
    expect(model.entries.map((entry) => entry.id)).toEqual(['ses_parent', 'ses_child', 'ses_ungrouped']);
  });

  test('projects duplicate folder ids from every group scope without merging their trees', () => {
    const projectSession = makeNode(makeSession('ses_project', 'Release project', PROJECT_ROOT));
    const worktreeSession = makeNode(makeSession('ses_worktree', 'Release worktree', WORKTREE_ROOT));
    const group = makeGroup('main', [projectSession, worktreeSession], {
      folderScopeKey: PROJECT_ROOT,
      folderScopes: [
        { scopeKey: PROJECT_ROOT, directory: PROJECT_ROOT },
        { scopeKey: WORKTREE_ROOT, directory: WORKTREE_ROOT },
      ],
    });
    const sharedFolder = { id: 'shared-folder', name: 'Shared folder', sessionIds: ['ses_project'], createdAt: 1 };
    const worktreeFolder = { id: 'shared-folder', name: 'Shared folder', sessionIds: ['ses_worktree'], createdAt: 2 };
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: {
        [PROJECT_ROOT]: [sharedFolder],
        [WORKTREE_ROOT]: [worktreeFolder],
      },
      groupSearchDataByGroup: searchDataFor(group),
    });

    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => ({
      scopeKey: row.scopeKey,
      folderId: row.folder.id,
      ownerKey: row.folderOwnerKey,
      nodeIds: row.nodes.map((node) => node.session.id),
    }))).toEqual([
      { scopeKey: PROJECT_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_project'] },
      { scopeKey: WORKTREE_ROOT, folderId: 'shared-folder', ownerKey: 'project', nodeIds: ['ses_worktree'] },
    ]);
    expect(model.rows.filter((row) => row.kind === 'session').map((row) => row.node.session.id)).toEqual(['ses_project', 'ses_worktree']);
  });

  test('keeps folder-only managed-chat matches from every chat scope', () => {
    const chatsRoot = '/home/user/chats';
    const datedChatsRoot = `${chatsRoot}/2026-09-13`;
    const chatGroup = makeGroup('managed-chats', [], {
      directory: chatsRoot,
      folderScopeKey: chatsRoot,
      folderScopes: [
        { scopeKey: chatsRoot, directory: chatsRoot },
        { scopeKey: datedChatsRoot, directory: datedChatsRoot },
      ],
      draftTarget: 'chat',
    });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      chatGroup,
      normalizedQuery: 'release',
      foldersMap: {
        [chatsRoot]: [{ id: 'shared-chat-folder', name: 'Release chats', sessionIds: [], createdAt: 1 }],
        [datedChatsRoot]: [{ id: 'shared-chat-folder', name: 'Release chats', sessionIds: [], createdAt: 2 }],
      },
      groupSearchDataByGroup: new WeakMap([[chatGroup, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 2,
        groupMatches: false,
        hasMatch: true,
      }]]),
      sections: [],
    });

    expect(model.rows.filter((row) => row.kind === 'folder').map((row) => ({
      scopeKey: row.scopeKey,
      ownerKey: row.folderOwnerKey,
      folderId: row.folder.id,
    }))).toEqual([
      { scopeKey: chatsRoot, ownerKey: chatsRoot, folderId: 'shared-chat-folder' },
      { scopeKey: datedChatsRoot, ownerKey: chatsRoot, folderId: 'shared-chat-folder' },
    ]);
  });

  test('keeps managed-chat session rows on the shared owner scope', () => {
    const chatsRoot = '/home/user/chats';
    const datedDirectory = `${chatsRoot}/2026-09-13/session-chat`;
    const chat = makeNode(makeSession('ses_chat', 'Release chat', datedDirectory));
    const chatGroup = makeGroup('managed-chats', [chat], {
      directory: chatsRoot,
      folderScopeKey: chatsRoot,
      folderScopes: [{ scopeKey: chatsRoot, directory: chatsRoot }],
      draftTarget: 'chat',
    });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      chatGroup,
      sections: [],
      groupSearchDataByGroup: searchDataFor(chatGroup),
    });
    const sessionRow = model.rows.find((row): row is Extract<typeof row, { kind: 'session' }> => row.kind === 'session');

    expect(sessionRow?.selectionScopeKey).toBe(chatsRoot);
    expect(model.entries[0]?.scopeKey).toBe(chatsRoot);
  });

  test('keeps folder-only archived matches visible without matching session rows', () => {
    const group = makeGroup('archived', [], { isArchivedBucket: true });
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([group])],
      chatGroup: null,
      foldersMap: {
        [PROJECT_ROOT]: [{ id: 'archived-folder', name: 'Release archive', sessionIds: [], createdAt: 1 }],
      },
      groupSearchDataByGroup: new WeakMap([[group, {
        filteredNodes: [],
        matchedSessionCount: 0,
        folderNameMatchCount: 1,
        groupMatches: false,
        hasMatch: true,
      }]]),
    });

    const folderRow = model.rows.find((row): row is Extract<typeof row, { kind: 'folder' }> => row.kind === 'folder');
    expect(folderRow?.folder.id).toBe('archived-folder');
    expect(folderRow?.archivedBucket).toBe(true);
    expect(model.rows.filter((row) => row.kind === 'session')).toHaveLength(0);
  });

  test('orders chats and recent rows before project rows while keeping duplicate occurrences', () => {
    const chat = makeNode(makeSession('ses_chat', 'Release chat', '/home/user/chats'));
     const recent = makeNode(makeSession('ses_duplicate', 'Release recent'));
     const project = makeNode(makeSession('ses_duplicate', 'Release project'));
    const chatGroup = makeGroup('managed-chats', [chat], {
      isMain: true,
      directory: '/home/user/chats',
      folderScopeKey: '/home/user/chats',
      draftTarget: 'chat',
    });
    const projectGroup = makeGroup('main', [project]);
    const model = buildSessionSearchRowModel({
      ...baseArgs(),
      sections: [makeProjectSection([projectGroup])],
      chatGroup,
      groupSearchDataByGroup: new WeakMap([
        [chatGroup, { filteredNodes: [chat], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true }],
        [projectGroup, { filteredNodes: [project], matchedSessionCount: 1, folderNameMatchCount: 0, groupMatches: false, hasMatch: true }],
      ]),
      showRecentSection: true,
      recentSections: [{
        key: 'active-now',
        items: [{
          node: recent,
          projectId: 'project',
          groupDirectory: PROJECT_ROOT,
          secondaryMeta: null,
        }],
      }],
    });

    expect(model.rows.map((row) => row.kind === 'activity-header' ? row.activityKey : row.kind === 'session' ? row.node.session.id : row.kind)).toEqual([
      'chats',
      'ses_chat',
      'active-now',
      'ses_duplicate',
      'project-header',
      'ses_duplicate',
    ]);
    expect(model.searchMatchCount).toBe(2);
    expect(model.entries.map((entry) => entry.id)).toEqual(['ses_chat', 'ses_duplicate', 'ses_duplicate']);
     expect(model.entries[1]?.rowKey).not.toBe(model.entries[2]?.rowKey);
   });
});
