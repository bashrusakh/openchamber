import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { killProcessTree, withProcessTreeOwnership } from './process-tree.js';

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

  it('keeps POSIX children detached and signals their process group', () => {
    expect(withProcessTreeOwnership({ cwd: '/repo' }, 'linux')).toEqual({ cwd: '/repo', detached: true });
    expect(withProcessTreeOwnership({ cwd: 'C:\\repo' }, 'win32')).toEqual({ cwd: 'C:\\repo', detached: false });
  });
});
