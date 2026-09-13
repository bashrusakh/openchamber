/**
 * Folder ids are unique only inside their persisted directory scope. This
 * identity is used for UI-only state such as folder collapse; folder records
 * and store APIs continue to use the bare folder UUID.
 */
export const getSessionFolderIdentityKey = (scopeKey: string, folderId: string): string => (
  `${scopeKey}\u0000${folderId}`
);
