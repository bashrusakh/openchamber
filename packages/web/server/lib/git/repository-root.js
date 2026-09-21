import os from 'node:os';
import path from 'node:path';

/**
 * A repository rooted at the user's home directory or a filesystem root
 * covers too much of the filesystem for OpenChamber Git operations. Treat it
 * as unsupported at the shared repository-context boundary so every runtime
 * makes the same decision before admitting work or falling back to raw Git.
 */
export const unsupportedRepositoryRootReason = (repoRoot, home = os.homedir()) => {
  if (String(repoRoot) !== repoRoot || !repoRoot.trim()) return null;
  const resolved = path.resolve(repoRoot.trim());
  if (path.resolve(path.parse(resolved).root) === resolved) return 'filesystem-root';
  if (String(home) === home && home.trim() && path.resolve(home.trim()) === resolved) return 'home';
  return null;
};

export const isUnsupportedRepositoryContext = (context) => (
  context?.isRepository === false
  && context?.reason === 'unsupported-repository-root'
);
