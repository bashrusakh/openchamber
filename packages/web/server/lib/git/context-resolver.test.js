import { describe, expect, it, vi } from 'vitest';

import { createGitContextResolver } from './context-resolver.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const waitFor = async (predicate) => {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (predicate()) {
      return;
    }
    await tick();
  }
};

describe('GitContextResolver', () => {
  it('uses one structured discovery command and derives linked-worktree identity', async () => {
    const calls = [];
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async (cwd, args) => {
        calls.push({ cwd, args });
        return { success: true, stdout: '/repo/worktree\n/repo/.git/worktrees/feature\n/repo/.git\n' };
      },
    });

    const result = await resolver.resolve('/repo/worktree/src');

    expect(result).toEqual({
      isRepository: true,
      requestedDirectory: '/repo/worktree/src',
      topLevel: '/repo/worktree',
      gitDir: '/repo/.git/worktrees/feature',
      commonDir: '/repo/.git',
      commonId: '/repo/.git',
      worktreeId: '/repo/worktree',
    });
    expect(calls).toEqual([{
      cwd: '/repo/worktree/src',
      args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    }]);
  });

  it('returns a non-repository context without inventing an identity', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({ success: false, stderr: 'fatal: not a git repository' }),
    });

    await expect(resolver.resolve('/not-a-repo')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/not-a-repo',
      reason: 'not-a-repository',
    });
  });

  it('returns a missing requested directory as non-repository without invoking Git', async () => {
    const runGit = vi.fn();
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => false,
      runGit,
    });

    await expect(resolver.resolve('/deleted-worktree')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/deleted-worktree',
      reason: 'not-a-repository',
    });
    expect(runGit).not.toHaveBeenCalled();
  });

  it('propagates requested-directory stat failures without invoking Git', async () => {
    const statError = Object.assign(new Error('permission denied while checking directory'), {
      code: 'EACCES',
    });
    const runGit = vi.fn();
    const resolver = createGitContextResolver({
      pathExists: async () => { throw statError; },
      runGit,
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toBe(statError);
    expect(runGit).not.toHaveBeenCalled();
  });

  it('accepts a structured non-repository discovery result', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'GIT_NOT_A_REPOSITORY',
        reason: 'not-a-repository',
      }),
    });

    await expect(resolver.resolve('/not-a-repo')).resolves.toEqual({
      isRepository: false,
      requestedDirectory: '/not-a-repo',
      reason: 'not-a-repository',
    });
  });

  it('keeps permission failures as structured discovery errors', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'EACCES',
        stderr: "fatal: cannot open '.git/HEAD': Permission denied",
      }),
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toMatchObject({
      code: 'EACCES',
      stderr: "fatal: cannot open '.git/HEAD': Permission denied",
      details: {
        operation: 'git-context-discovery',
        cwd: '/protected-repo',
      },
    });
  });

  it('wraps thrown discovery failures with execution context', async () => {
    const error = new Error('permission denied while reading repository metadata');
    error.code = 'EACCES';
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => { throw error; },
    });

    await expect(resolver.resolve('/protected-repo')).rejects.toMatchObject({
      code: 'EACCES',
      details: {
        operation: 'git-context-discovery',
        cwd: '/protected-repo',
        args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      },
    });
  });

  it('keeps missing Git failures as structured discovery errors', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: false,
        code: 'ENOENT',
        exitCode: 127,
        stderr: 'git: command not found',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      code: 'ENOENT',
      exitCode: 127,
      stderr: 'git: command not found',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('keeps incomplete discovery output as an error', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '/repo\n/repo/.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned incomplete output',
      stdout: '/repo\n/repo/.git\n',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('rejects complete-looking discovery output without a valid repository identity', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: 'repository\n.git\n.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned a repository root outside the requested directory',
      details: {
        operation: 'git-context-discovery',
        cwd: '/repo',
      },
    });
  });

  it('rejects a partial relative identity mixed with absolute discovery output', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '/repo\n.git\n.git\n',
      }),
    });

    await expect(resolver.resolve('/repo')).rejects.toMatchObject({
      message: 'Git context discovery returned a non-absolute repository identity',
    });
  });

  it('resolves relative common-directory output from the discovery CWD', async () => {
    const resolver = createGitContextResolver({
      pathExists: async () => true,
      runGit: async () => ({
        success: true,
        stdout: '../\n../../.git/worktrees/feature\n./.git\n',
      }),
    });

    await expect(resolver.resolve('/repo/worktree/src')).resolves.toMatchObject({
      topLevel: '/repo/worktree',
      gitDir: '/repo/.git/worktrees/feature',
      commonDir: '/repo/worktree/src/.git',
    });
  });

  it('canonicalizes symlink aliases before caching repository identity', async () => {
    const calls = [];
    const resolver = createGitContextResolver({
      realpath: async (value) => value.replace('/link', ''),
      pathExists: async () => true,
      runGit: async (cwd) => {
        calls.push(cwd);
        return { success: true, stdout: '/repo/src\n/repo/.git\n/repo/.git\n' };
      },
    });

    await resolver.resolve('/repo/link/src');
    await resolver.resolve('/repo/src');

    expect(calls).toEqual(['/repo/src']);
  });

  it('keeps shared discovery alive when one waiter is cancelled', async () => {
    const firstController = new AbortController();
    let releaseDiscovery;
    const discovery = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    let calls = 0;
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async () => {
        calls += 1;
        return discovery;
      },
    });

    const first = resolver.resolve('/repo', { signal: firstController.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    const second = resolver.resolve('/repo');

    firstController.abort('first waiter no longer needs discovery');
    await expect(first).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });

    releaseDiscovery({
      success: true,
      stdout: '/repo\n/repo/.git\n/repo/.git\n',
    });

    await expect(second).resolves.toMatchObject({
      isRepository: true,
      topLevel: '/repo',
      commonId: '/repo/.git',
    });
    expect(calls).toBe(1);
    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });

  it('cleans up shared discovery after its only waiter is cancelled', async () => {
    const controller = new AbortController();
    let releaseDiscovery;
    const discovery = new Promise((resolve) => {
      releaseDiscovery = resolve;
    });
    const resolver = createGitContextResolver({
      realpath: async (value) => value,
      pathExists: async () => true,
      runGit: async () => discovery,
    });

    const request = resolver.resolve('/repo', { signal: controller.signal });
    await waitFor(() => resolver.getStats().inFlightAliases === 1);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: 'GIT_EXECUTION_CANCELLED' });

    releaseDiscovery({
      success: true,
      stdout: '/repo\n/repo/.git\n/repo/.git\n',
    });
    await tick();

    expect(resolver.getStats()).toMatchObject({
      inFlightAliases: 0,
      inFlightContexts: 0,
      discovery: { active: 0, pending: 0 },
    });
  });
});
