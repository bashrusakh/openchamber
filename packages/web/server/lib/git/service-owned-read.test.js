import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { getRangeDiff } from './service.js';

const temporaryRoots = [];
const execFileAsync = promisify(execFile);

const runGit = async (directory, args) => {
  await execFileAsync('git', args, {
    cwd: directory,
    windowsHide: true,
  });
};

afterEach(async () => {
  const roots = temporaryRoots.splice(0);
  await Promise.all(roots.map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('owned web Git reads', () => {
  it('cancels a range read through the owned process-tree boundary', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'openchamber-owned-read-'));
    const marker = path.join(directory, 'diff-started');
    const externalDiff = path.join(directory, 'external-diff.mjs');
    temporaryRoots.push(directory);

    await runGit(directory, ['init', '-b', 'main']);
    await runGit(directory, ['config', 'user.email', 'test@example.com']);
    await runGit(directory, ['config', 'user.name', 'Test']);
    await fs.writeFile(path.join(directory, 'file.txt'), 'base\n');
    await runGit(directory, ['add', 'file.txt']);
    await runGit(directory, ['commit', '-m', 'base']);
    await runGit(directory, ['switch', '-c', 'feature']);
    await fs.writeFile(path.join(directory, 'file.txt'), 'feature\n');
    await runGit(directory, ['commit', '-am', 'feature']);

    await fs.writeFile(externalDiff, `import fs from 'node:fs';

fs.writeFileSync(${JSON.stringify(marker)}, 'started');
setInterval(() => {}, 1_000);
`);
    await fs.chmod(externalDiff, 0o755);
    await runGit(directory, ['config', 'diff.external', `${process.execPath} ${externalDiff}`]);

    const controller = new AbortController();
    const pending = getRangeDiff(directory, {
      base: 'main',
      head: 'feature',
      signal: controller.signal,
    });

    await vi.waitFor(async () => {
      await expect(fs.readFile(marker, 'utf8')).resolves.toBe('started');
    });
    controller.abort(new Error('cancelled by test'));

    await expect(pending).rejects.toThrow();
  });
});
