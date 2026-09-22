import assert from 'node:assert/strict';
import { test } from 'node:test';
import { spawnOwnedProcess } from './owned-process';

test('POSIX cleanup keeps the owned lease pending until the process group is gone', async () => {
  const groupChecks: Array<number> = [];
  let confirmedChecks = 0;
  const owned = spawnOwnedProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 20)'],
    { cwd: process.cwd(), env: process.env },
    {
      platform: 'linux',
      terminationGraceMs: 0,
      terminationTimeoutMs: 100,
      processKill: (pid, signal) => {
        if (signal === 0) {
          groupChecks.push(pid);
          confirmedChecks += 1;
          if (confirmedChecks >= 3) {
            const error = Object.assign(new Error('group is gone'), { code: 'ESRCH' });
            throw error;
          }
        }
      },
    },
  );
  const termination = owned.terminate();
  let terminationSettled = false;
  void termination.then(() => { terminationSettled = true; });

  await owned.closed;
  assert.equal(terminationSettled, false);
  await termination;
  assert.equal(terminationSettled, true);
  assert.ok(groupChecks.every((pid) => pid < 0));
});

test('POSIX cleanup reports blocked descendants when group confirmation times out', async () => {
  const owned = spawnOwnedProcess(
    process.execPath,
    ['-e', 'setTimeout(() => {}, 10)'],
    { cwd: process.cwd(), env: process.env },
    {
      platform: 'linux',
      terminationGraceMs: 0,
      terminationTimeoutMs: 20,
      processKill: (_pid, signal) => {
        if (signal === 0) return;
      },
    },
  );

  await assert.rejects(owned.terminate(), (error: Error & { code?: string; cleanupBlocked?: boolean; descendantsTerminated?: boolean }) => {
    assert.equal(error.code, 'ERR_PROCESS_TREE_TERMINATION');
    assert.equal(error.cleanupBlocked, true);
    assert.equal(error.descendantsTerminated, false);
    return true;
  });
});
