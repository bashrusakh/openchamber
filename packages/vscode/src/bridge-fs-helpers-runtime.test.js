import { describe, expect, it, mock } from 'bun:test';

const workspace = {
  workspaceFolders: [{ uri: { fsPath: '/repo' } }],
  findFiles: mock(async () => [{ fsPath: '/repo/visible.ts' }]),
  fs: {
    readDirectory: mock(async () => []),
  },
};

mock.module('vscode', () => ({
  workspace,
  Uri: {
    file: (fsPath) => ({ fsPath }),
    joinPath: (uri, name) => ({ fsPath: `${uri.fsPath}/${name}` }),
  },
  RelativePattern: class RelativePattern {
    constructor(base, pattern) {
      this.base = base;
      this.pattern = pattern;
    }
  },
  FileType: {
    Directory: 2,
    File: 1,
  },
}));

const { parseGitCheckIgnoreResult, searchDirectory } = await import('./bridge-fs-helpers-runtime');

describe('filesystem Gitignore handling', () => {
  it('keeps no-match and confirmed non-repository results empty', () => {
    expect(parseGitCheckIgnoreResult({ stdout: '', stderr: '', exitCode: 1 }, '/repo')).toEqual(new Set());
    expect(parseGitCheckIgnoreResult({
      stdout: '',
      stderr: 'fatal: not a git repository',
      exitCode: 128,
    }, '/not-a-repo')).toEqual(new Set());
  });

  it('propagates authoritative Gitignore adapter failures', async () => {
    const runGitRead = mock(async () => ({
      stdout: '',
      stderr: 'EACCES: permission denied while checking Gitignore (not a git repository)',
      exitCode: 1,
      code: 'EACCES',
    }));

    await expect(searchDirectory('/repo', 'visible', 60, false, true, runGitRead))
      .rejects.toThrow('Gitignore discovery failed');
    expect(runGitRead).toHaveBeenCalledTimes(1);
  });
});
