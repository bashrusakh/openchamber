import { describe, expect, it } from 'vitest';

import { createGitExecutionService } from './execution-service.js';
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
    let service;
    const raw = {
      createGit: async (cwd, options) => {
        observations.push({ type: 'discovery', cwd, env: options?.envOverrides });
        return {
          raw: async () => '/repo\n/repo/.git\n/repo/.git\n',
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

    await expect(service.getDiff('/repo', 'file.ts')).resolves.toBe('diff');
    await expect(service.stageFile('/repo', 'file.ts')).resolves.toBeUndefined();

    expect(observations).toEqual([
      {
        type: 'discovery',
        cwd: '/repo',
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
