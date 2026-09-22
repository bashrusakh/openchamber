import fs from 'fs';
import { isGitProcessCleanupBlocked } from './execution-errors.js';

const fsp = fs.promises;

export const cleanupWorkingTreeRangeDirectory = async (temporaryDirectory, operationError) => {
  // A failed process-tree termination means the Git child may still hold the
  // temporary index. Keep it in place until ownership is confirmed; removing
  // it here can turn the original termination failure into an ordinary cleanup
  // error and release the surrounding read lease too early.
  if (operationError && isGitProcessCleanupBlocked(operationError)) {
    return;
  }

  try {
    await fsp.rm(temporaryDirectory, { recursive: true, force: true });
  } catch (cleanupError) {
    // Preserve the operation's original failure, especially its process-tree
    // metadata. A cleanup failure is only the primary error after success.
    if (operationError) return;
    throw cleanupError;
  }
};
