import type { SessionGroup, SessionGroupFolderScope } from '../types';
import { getChatsRootFromDirectory } from '@/lib/chatDirectories';
import { normalizePath } from '../utils';

export { getSessionFolderIdentityKey } from '@/lib/sessionFolderIdentity';

export const getSessionFolderOwnerKey = (
  projectId: string | null | undefined,
  managedChatDirectory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(managedChatDirectory) ?? normalizePath(managedChatDirectory ?? null);

/**
 * Selection groups are logical containers, not necessarily the directory that
 * owns a session's messages. Managed Chats therefore select by their shared
 * root while ordinary unowned rows retain their directory fallback.
 */
export const getSessionSelectionScopeKey = (
  projectId: string | null | undefined,
  sessionDirectory: string | null | undefined,
): string | null => projectId ?? getChatsRootFromDirectory(sessionDirectory) ?? normalizePath(sessionDirectory ?? null);

export const getSessionFolderScopes = (group: Pick<SessionGroup, 'folderScopes' | 'folderScopeKey' | 'directory'>): SessionGroupFolderScope[] => {
  if (group.folderScopes && group.folderScopes.length > 0) return group.folderScopes;
  const scopeKey = group.folderScopeKey ?? normalizePath(group.directory ?? null);
  return scopeKey ? [{ scopeKey, directory: group.directory }] : [];
};
