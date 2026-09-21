import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import {
  execFileProcessTree,
  killProcessTree,
  withProcessTreeOwnership,
} from './process-tree.js';

describe('Git process-tree ownership', () => {
  it('waits for Windows taskkill to finish enumerating descendants', async () => {
    const child = { pid: 1234, kill: vi.fn() };
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, { spawn, platform: 'win32' });
    let settled = false;
    void termination.then(() => { settled = true; });
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(child.kill).not.toHaveBeenCalled();
    expect(spawn).toHaveBeenCalledWith(
      'taskkill',
      ['/pid', '1234', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore' },
    );

    taskkill.emit('close', 0);
    await termination;
    expect(settled).toBe(true);
  });

  it('reports taskkill failure after attempting a bounded root fallback', async () => {
    const child = { pid: 1234, kill: vi.fn() };
    const taskkill = new EventEmitter();
    const spawn = vi.fn(() => taskkill);

    const termination = killProcessTree(child, {
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    taskkill.emit('error', new Error('taskkill unavailable'));

    await expect(termination).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles cancellation with an explicit cleanup failure when Windows taskkill fails', async () => {
    const child = new EventEmitter();
    child.pid = 1234;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const controller = new AbortController();
    const spawn = vi.fn((command) => (command === 'taskkill' ? taskkill : child));

    const pending = execFileProcessTree({
      command: 'git',
      args: ['status'],
      signal: controller.signal,
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    controller.abort();
    taskkill.emit('error', new Error('taskkill failed'));

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      operationError: { code: 'ABORT_ERR' },
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles max-buffer cleanup with an explicit Windows termination failure', async () => {
    const child = new EventEmitter();
    child.pid = 1235;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const taskkill = new EventEmitter();
    const spawn = vi.fn((command) => (command === 'taskkill' ? taskkill : child));

    const pending = execFileProcessTree({
      command: 'git',
      args: ['status'],
      maxBuffer: 1,
      spawn,
      platform: 'win32',
      terminationTimeoutMs: 5,
    });
    child.stdout.emit('data', Buffer.from('12'));
    taskkill.emit('error', new Error('taskkill failed during max-buffer cleanup'));

    await expect(pending).rejects.toMatchObject({
      code: 'ERR_PROCESS_TREE_TERMINATION',
      operationError: { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
      descendantsTerminated: false,
    });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('keeps POSIX children detached and signals their process group', () => {
    expect(withProcessTreeOwnership({ cwd: '/repo' }, 'linux')).toEqual({ cwd: '/repo', detached: true });
    expect(withProcessTreeOwnership({ cwd: 'C:\\repo' }, 'win32')).toEqual({ cwd: 'C:\\repo', detached: false });
  });
});
