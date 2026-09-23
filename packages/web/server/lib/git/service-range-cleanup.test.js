import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { cleanupWorkingTreeRangeDirectory } from './range-cleanup.js';

describe('working-tree range temporary cleanup', () => {
  it('retains the temporary index when process-tree cleanup is unconfirmed', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-branch-diff-'));
    const temporaryIndex = path.join(temporaryDirectory, 'index');
    await fs.writeFile(temporaryIndex, 'temporary index');

    try {
      const operationError = Object.assign(new Error('Git process cleanup was not confirmed'), {
        code: 'ERR_PROCESS_TREE_TERMINATION',
        cleanupBlocked: true,
        descendantsTerminated: false,
        rootClosed: false,
        pid: 1234,
      });

      await cleanupWorkingTreeRangeDirectory(temporaryDirectory, operationError);

      await expect(fs.readFile(temporaryIndex, 'utf8')).resolves.toBe('temporary index');
      await expect(fs.stat(temporaryDirectory)).resolves.toBeTruthy();
    } finally {
      await fs.rm(temporaryDirectory, { recursive: true, force: true });
    }
  });

  it('reaps a retained temporary index after the owned process closes', async () => {
    const temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-branch-diff-'));
    await fs.writeFile(path.join(temporaryDirectory, 'index'), 'temporary index');
    let close;
    const operationError = Object.assign(new Error('Git process cleanup was not confirmed'), {
      code: 'ERR_PROCESS_TREE_TERMINATION',
      cleanupBlocked: true,
      descendantsTerminated: false,
      rootClosed: false,
      pid: 1234,
      cleanupReconciliation: {
        promise: new Promise((resolve) => { close = resolve; }),
        retire: () => close?.(),
      },
    });

    await cleanupWorkingTreeRangeDirectory(temporaryDirectory, operationError);
    await expect(fs.stat(temporaryDirectory)).resolves.toBeTruthy();
    close();
    await expect.poll(() => fs.stat(temporaryDirectory).then(() => true, () => false)).toBe(false);
  });
});
