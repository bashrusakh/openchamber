import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

const spawnCalls = [];
const getGitExecutablePath = mock();
const execFile = mock();
const spawn = mock((command, args, options) => {
  const childProcess = new EventEmitter();
  childProcess.stdout = new EventEmitter();
  childProcess.stderr = new EventEmitter();
  spawnCalls.push({ command, args, options });
  queueMicrotask(() => childProcess.emit('close', 0));
  return childProcess;
});

mock.module('child_process', () => ({
  execFile,
  spawn,
}));

mock.module('./gitService', () => ({
  getGitExecutablePath,
}));

const { createGitProcessRuntime, stopGitProcesses } = await import('./bridge-git-process-runtime');

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
    execFile.mockReset();
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

  it('kills an active process on abort and settles only after child exit', async () => {
    const childProcess = new EventEmitter();
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = mock();
    spawn.mockImplementationOnce(() => childProcess);

    const controller = new AbortController();
    const runtime = createGitProcessRuntime();
    const pending = runtime.execGit(['status'], '/repo', { signal: controller.signal });
    for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }

    controller.abort('cancelled by test');
    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');

    let settled = false;
    void pending.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    childProcess.emit('close', null);
    await expect(pending).resolves.toMatchObject({ exitCode: 1 });
    childProcess.emit('error', new Error('late child error'));
    expect(childProcess.kill).toHaveBeenCalledTimes(1);
  });

  it('rejects a command when either output stream exceeds its buffer limit', async () => {
    const childProcess = new EventEmitter();
    childProcess.stdout = new EventEmitter();
    childProcess.stderr = new EventEmitter();
    childProcess.kill = mock();
    spawn.mockImplementationOnce(() => childProcess);

    const runtime = createGitProcessRuntime();
    const pending = runtime.execGit(['status'], '/repo', { maxBuffer: 4 });
    for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
      await Promise.resolve();
    }
    childProcess.stderr.emit('data', Buffer.from('12345'));
    childProcess.emit('close', null);

    await expect(pending).resolves.toMatchObject({
      exitCode: 1,
      code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      stderr: expect.stringMatching(/maxBuffer/),
    });
    expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('settles cancellation when Windows taskkill fails and does not claim tree cleanup', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1234;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('taskkill failed'));
      });

      const controller = new AbortController();
      const pending = createGitProcessRuntime().execGit(['status'], '/repo', {
        signal: controller.signal,
      });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      controller.abort();

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('settles max-buffer cleanup with an explicit Windows termination failure', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1235;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('taskkill failed during max-buffer cleanup'));
      });

      const pending = createGitProcessRuntime().execGit(['status'], '/repo', { maxBuffer: 1 });
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      childProcess.stdout.emit('data', Buffer.from('12'));

      await expect(pending).resolves.toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(childProcess.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

  it('settles deactivation after a failed Windows tree kill without releasing twice', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'win32' });
    try {
      const childProcess = new EventEmitter();
      childProcess.stdout = new EventEmitter();
      childProcess.stderr = new EventEmitter();
      childProcess.pid = 1236;
      childProcess.exitCode = null;
      childProcess.signalCode = null;
      childProcess.kill = mock();
      spawn.mockImplementationOnce(() => childProcess);
      execFile.mockImplementationOnce((_command, _args, _options, callback) => {
        callback(new Error('taskkill failed during deactivation'));
      });

      const pending = createGitProcessRuntime().execGit(['status'], '/repo');
      for (let attempt = 0; attempt < 5 && spawnCalls.length === 0; attempt += 1) {
        await Promise.resolve();
      }
      await stopGitProcesses();
      const result = await pending;

      expect(result).toMatchObject({
        exitCode: 1,
        stderr: expect.stringMatching(/Failed to terminate.*descendant termination was not confirmed/),
        cleanupBlocked: true,
        descendantsTerminated: false,
      });
      expect(childProcess.kill).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
    }
  });

});
