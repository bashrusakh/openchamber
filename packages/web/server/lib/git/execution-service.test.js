import { describe, expect, it } from 'vitest';

import { createGitExecutionService } from './execution-service.js';
import { GIT_OPERATION_KIND } from './execution-coordinator.js';
import { getGitExecutionEnv } from './execution-scope.js';

const contextFor = (directory) => ({
  isRepository: true,
  commonId: '/repo/.git',
  worktreeId: directory,
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Git execution service', () => {
  it('coordinates wrapped worktree reads and writes through the shared scheduler', async () => {
    const calls = [];
    let releaseWrite;
    const raw = {
      stageFile: async () => {
        calls.push('write-start');
        return new Promise((resolve) => {
          releaseWrite = () => {
            calls.push('write-end');
            resolve('staged');
          };
        });
      },
      getDiff: async () => {
        calls.push('read');
        return 'diff';
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const write = service.stageFile('/repo', 'file.ts');
    await tick();
    const read = service.getDiff('/repo', 'file.ts', false, 3);
    await tick();

    expect(calls).toEqual(['write-start']);
    releaseWrite();
    await expect(write).resolves.toBe('staged');
    await expect(read).resolves.toBe('diff');
    expect(calls).toEqual(['write-start', 'write-end', 'read']);
  });

  it('applies optional-lock suppression only inside coordinated read execution', async () => {
    const observations = [];
    const directory = process.cwd();
    let service;
    const raw = {
      createGit: async (cwd, options) => {
        observations.push({ type: 'discovery', cwd, env: options?.envOverrides });
        return {
          raw: async () => `${directory}\n${directory}/.git\n${directory}/.git\n`,
        };
      },
      getDiff: async () => {
        observations.push({
          type: 'read',
          env: getGitExecutionEnv(),
          active: service.coordinator.getStats().active,
        });
        return 'diff';
      },
      stageFile: async () => {
        observations.push({
          type: 'write',
          env: getGitExecutionEnv(),
          active: service.coordinator.getStats().active,
        });
      },
    };
    service = createGitExecutionService({ raw });

    await expect(service.getDiff(directory, 'file.ts')).resolves.toBe('diff');
    await expect(service.stageFile(directory, 'file.ts')).resolves.toBeUndefined();

    expect(observations).toEqual([
      {
        type: 'discovery',
        cwd: directory,
        env: { GIT_OPTIONAL_LOCKS: '0' },
      },
      {
        type: 'read',
        env: { GIT_OPTIONAL_LOCKS: '0' },
        active: 1,
      },
      {
        type: 'write',
        env: {},
        active: 1,
      },
    ]);
  });

  it('uses the active lease for attachment and queues bootstrap on its new worktree', async () => {
    const calls = [];
    const raw = {
      createWorktree: async (directory, input, options) => {
        const attachment = await options.scheduleBackground(
          {
            operation: 'worktreeAttachment',
            contextDirectory: directory,
          },
          async () => {
            calls.push('attachment');
          },
        );
        const bootstrap = options.scheduleBackground(
          {
            operation: 'worktreeBootstrap',
            contextDirectory: '/repo/worktree',
          },
          async () => {
            calls.push('bootstrap');
          },
        );
        return { attachment, bootstrap, input };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    const result = await service.createWorktree('/repo', { worktreeName: 'feature' });
    await result.bootstrap;

    expect(calls).toEqual(['attachment', 'bootstrap']);
    expect(result.input).toEqual({ worktreeName: 'feature' });
  });

  it('keeps non-repository identity calls on the raw fallback path', async () => {
    const calls = [];
    const raw = {
      getCurrentIdentity: async (directory) => {
        calls.push(directory);
        return { userName: 'User', userEmail: 'user@example.test' };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => ({
        isRepository: false,
        requestedDirectory: directory,
        reason: 'not-a-repository',
      }) },
    });

    await expect(service.getCurrentIdentity('/not-a-repo')).resolves.toEqual({
      userName: 'User',
      userEmail: 'user@example.test',
    });
    expect(calls).toEqual(['/not-a-repo']);
  });

  it('keeps deleted-directory checks and status on the soft raw fallback path', async () => {
    const calls = [];
    const raw = {
      getStatus: async (directory, options) => {
        calls.push({ directory, options });
        return { isGitRepository: false, files: [] };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => ({
        isRepository: false,
        requestedDirectory: directory,
        reason: 'not-a-repository',
      }) },
    });

    await expect(service.isGitRepository('/deleted-worktree')).resolves.toBe(false);
    await expect(service.getStatus('/deleted-worktree')).resolves.toEqual({
      isGitRepository: false,
      files: [],
    });
    expect(calls).toEqual([{
      directory: '/deleted-worktree',
      options: undefined,
    }]);
  });

  it('propagates a missing Git executable discovery failure', async () => {
    const failure = Object.assign(new Error('Git executable is unavailable'), {
      code: 'ENOENT',
      details: { operation: 'git-context-discovery' },
    });
    const service = createGitExecutionService({
      raw: {},
      resolver: { resolve: async () => { throw failure; } },
    });

    await expect(service.isGitRepository('/repo')).rejects.toBe(failure);
  });

  it('classifies branch and commit checkout as worktree-scoped writes', async () => {
    const kinds = [];
    const raw = {
      checkoutBranch: async () => 'branch',
      checkoutCommit: async () => 'commit',
    };
    const service = createGitExecutionService({
      raw,
      coordinator: {
        run: async (options, task) => {
          kinds.push(options.kind);
          return task();
        },
      },
      resolver: { resolve: async (directory) => contextFor(directory) },
    });

    await expect(service.checkoutBranch('/repo', 'feature')).resolves.toBe('branch');
    await expect(service.checkoutCommit('/repo', '0123456789abcdef')).resolves.toBe('commit');
    expect(kinds).toEqual([
      GIT_OPERATION_KIND.WORKTREE_WRITE,
      GIT_OPERATION_KIND.WORKTREE_WRITE,
    ]);
  });

  it('resolves integration operations from their repository input', async () => {
    const calls = [];
    const raw = {
      computeIntegratePlan: async (input) => {
        calls.push(input);
        return { commits: [] };
      },
    };
    const service = createGitExecutionService({
      raw,
      resolver: { resolve: async (directory) => {
        calls.push(directory);
        return contextFor(directory);
      } },
    });

    await expect(service.computeIntegratePlan({
      repoRoot: '/repo',
      sourceBranch: 'feature',
      targetBranch: 'main',
    })).resolves.toEqual({ commits: [] });
    expect(calls).toEqual([
      '/repo',
      { repoRoot: '/repo', sourceBranch: 'feature', targetBranch: 'main' },
    ]);
  });
});
