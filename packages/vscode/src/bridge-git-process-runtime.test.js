import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnCalls = [];
const getGitExecutablePath = mock();
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  spawnCalls.push({ command, args, options });
  queueMicrotask(() => childProcess.emit('close', 0));
  return childProcess;
});

mock.module('child_process', () => ({
  execFile: mock(),
  spawn,
}));

mock.module('./gitService', () => ({
  getGitExecutablePath,
}));

const { createGitProcessRuntime } = await import('./bridge-git-process-runtime');

describe('VS Code Git process runtime executable selection', () => {
  const originalSshAuthSock = process.env.SSH_AUTH_SOCK;

  beforeAll(() => {
    process.env.SSH_AUTH_SOCK = '/tmp/openchamber-test-agent.sock';
  });

  afterAll(() => {
    if (originalSshAuthSock === undefined) {
      delete process.env.SSH_AUTH_SOCK;
    } else {
      process.env.SSH_AUTH_SOCK = originalSshAuthSock;
    }
  });

  beforeEach(() => {
    getGitExecutablePath.mockReset();
    getGitExecutablePath.mockResolvedValue(undefined);
    spawn.mockClear();
    spawnCalls.length = 0;
  });

  it('uses the configured Git executable for discovery', async () => {
    getGitExecutablePath.mockResolvedValue('/custom/bin/git');
    const runtime = createGitProcessRuntime();

    await expect(runtime.execGit(['rev-parse'], '/repo')).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    expect(spawnCalls[0]).toMatchObject({
      command: '/custom/bin/git',
      args: ['rev-parse'],
      options: { cwd: '/repo' },
    });
  });

  it('keeps the raw Git fallback when no configured executable is available', async () => {
    const runtime = createGitProcessRuntime();

    await expect(runtime.execGit(['rev-parse'], '/repo')).resolves.toEqual({
      stdout: '',
      stderr: '',
      exitCode: 0,
    });
    expect(spawnCalls[0]).toMatchObject({
      command: 'git',
      args: ['rev-parse'],
      options: { cwd: '/repo' },
    });
  });
});
