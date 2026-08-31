import { describe, expect, it, mock } from 'bun:test';

import { getGitExecutionEnv } from './git-execution-scope';

const calls = [];
const execGit = mock(async (args, cwd) => {
  calls.push({ args, cwd, env: getGitExecutionEnv() });
  return {
    stdout: '',
    stderr: 'fatal: permission denied while reading repository metadata',
    exitCode: 1,
    code: 'EACCES',
  };
});

mock.module('./bridge-git-process-runtime', () => ({ execGit }));

const { createGitExecutionRuntime } = await import('./git-execution-runtime');

describe('VS Code Git execution runtime discovery', () => {
  it('runs discovery as a read and preserves process error codes', async () => {
    calls.length = 0;

    const runtime = createGitExecutionRuntime();

    await expect(runtime.discover('/repo')).rejects.toMatchObject({
      code: 'EACCES',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
    expect(calls).toEqual([{
      args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      cwd: '/repo',
      env: { GIT_OPTIONAL_LOCKS: '0' },
    }]);
  });

  it('falls back to the service adapter when the raw discovery executable is unavailable', async () => {
    const resolver = {
      resolve: mock(async () => {
        throw {
          code: 'ENOENT',
          details: { operation: 'git-context-discovery' },
        };
      }),
    };
    const runtime = createGitExecutionRuntime({ resolver });
    const task = mock(async (lease) => lease.kind);

    await expect(runtime.runServiceOperation('getGitStatus', '/repo', task)).resolves.toBe('read');
    expect(task).toHaveBeenCalledWith(expect.objectContaining({
      commonId: '/repo',
      worktreeId: '/repo',
      kind: 'read',
    }));
  });
});
