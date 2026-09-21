import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { spawnOwnedProcess } from './owned-process';
import { getGitExecutablePath } from './gitService';
import { getGitExecutionEnv } from './git-execution-scope';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

export type GitProcessRuntimeOptions = {
  resolveGitExecutable?: () => Promise<string | undefined>;
};

export type GitProcessExecutionOptions = {
  signal?: AbortSignal;
  binary?: string;
  timeoutMs?: number;
  maxBuffer?: number;
};

export type GitProcessExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
  code?: string;
  cleanupBlocked?: boolean;
  descendantsTerminated?: boolean;
  rootClosed?: boolean;
  pid?: number;
  cause?: Error;
  rootError?: Error;
  operationError?: Error;
};

const isSocketPath = async (candidate: string): Promise<boolean> => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return stat.isSocket();
  } catch {
    return false;
  }
};

const resolveSshAuthSock = async (): Promise<string | undefined> => {
  const existing = (process.env.SSH_AUTH_SOCK || '').trim();
  if (existing) {
    return existing;
  }

  if (process.platform === 'win32') {
    return undefined;
  }

  const gpgSock = path.join(os.homedir(), '.gnupg', 'S.gpg-agent.ssh');
  if (await isSocketPath(gpgSock)) {
    return gpgSock;
  }

  const runGpgconf = async (args: string[]): Promise<string> => {
    for (const candidate of gpgconfCandidates) {
      try {
        const { stdout } = await execFileAsync(candidate, args);
        return String(stdout || '');
      } catch {
        continue;
      }
    }
    return '';
  };

  const candidate = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
  if (candidate && await isSocketPath(candidate)) {
    return candidate;
  }

  if (candidate) {
    await runGpgconf(['--launch', 'gpg-agent']);
    const retried = (await runGpgconf(['--list-dirs', 'agent-ssh-socket'])).trim();
    if (retried && await isSocketPath(retried)) {
      return retried;
    }
  }

  return undefined;
};

const buildGitEnv = async (): Promise<NodeJS.ProcessEnv> => {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (!env.SSH_AUTH_SOCK || !env.SSH_AUTH_SOCK.trim()) {
    const resolved = await resolveSshAuthSock();
    if (resolved) {
      env.SSH_AUTH_SOCK = resolved;
    }
  }
  return env;
};

const activeProcesses = new Set<ReturnType<typeof spawnOwnedProcess>>();
let shutdown: Promise<void> | null = null;

export const stopGitProcesses = (): Promise<void> => {
  if (!shutdown) shutdown = (async () => {
    const results = await Promise.allSettled([...activeProcesses].map((process) => process.terminate()));
    for (const result of results) {
      if (result.status === 'rejected') console.warn('Failed to stop a Git process:', result.reason);
    }
  })();
  return shutdown;
};

const getErrorCode = (error: Error): string | undefined => {
  // SAFETY: child-process failures use Node's optional errno code field.
  const code = (error as NodeJS.ErrnoException).code;
  return String(code) === code ? code : undefined;
};

type OwnedProcessFailure = Error & {
  cleanupBlocked?: boolean;
  descendantsTerminated?: boolean;
  rootClosed?: boolean;
  pid?: number;
  rootError?: Error;
  operationError?: Error;
};

const processFailure = (error: OwnedProcessFailure): GitProcessExecutionResult => {
  const result: GitProcessExecutionResult = {
    stdout: '',
    stderr: error.message,
    exitCode: 1,
    code: getErrorCode(error),
  };
  if (error.cleanupBlocked === true) result.cleanupBlocked = true;
  if (error.descendantsTerminated === false) result.descendantsTerminated = false;
  if ('rootClosed' in error && (error.rootClosed === true || error.rootClosed === false)) {
    result.rootClosed = error.rootClosed;
  }
  if (Number.isInteger(error.pid)) result.pid = error.pid;
  if (error.cause instanceof Error) result.cause = error.cause;
  if (error.rootError !== undefined) result.rootError = error.rootError;
  if (error.operationError !== undefined) result.operationError = error.operationError;
  return result;
};

export const createGitProcessRuntime = ({
  resolveGitExecutable = getGitExecutablePath,
}: GitProcessRuntimeOptions = {}) => {
  const execGit = async (
    args: string[],
    cwd: string,
    options: GitProcessExecutionOptions = {},
  ): Promise<GitProcessExecutionResult> => {
    let env: NodeJS.ProcessEnv;
    let configuredPath: string | undefined;
    try {
      [env, configuredPath] = await Promise.all([
        buildGitEnv(),
        resolveGitExecutable(),
      ]);
    } catch (error) {
      return processFailure(error instanceof Error ? error : new Error(String(error)));
    }
    if (shutdown) return { stdout: '', stderr: 'Git runtime is shutting down', exitCode: 1 };
    if (options.signal?.aborted) {
      return processFailure(options.signal.reason || new Error('Git process was cancelled'));
    }

    const process = spawnOwnedProcess(options.binary?.trim() || configuredPath?.trim() || 'git', args, {
      cwd,
      env: { ...env, ...getGitExecutionEnv() },
    });
    activeProcesses.add(process);
    const forgetProcess = () => { activeProcesses.delete(process); };
    void process.closed.then(forgetProcess);
    void process.failedTermination.then(forgetProcess);
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let outputLimitExceeded: string | undefined;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let termination: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const maxBuffer = options.maxBuffer !== undefined
      && Number.isFinite(options.maxBuffer)
      && options.maxBuffer >= 0
      ? options.maxBuffer
      : Number.POSITIVE_INFINITY;
    const appendOutput = (stream: 'stdout' | 'stderr', data: Buffer) => {
      if (outputLimitExceeded) return;
      const text = data.toString();
      if (stream === 'stdout') {
        stdoutBytes += Buffer.byteLength(text);
        if (stdoutBytes > maxBuffer) {
          outputLimitExceeded = `Git command stdout exceeded maxBuffer of ${maxBuffer} bytes`;
        } else {
          stdout += text;
        }
      } else {
        stderrBytes += Buffer.byteLength(text);
        if (stderrBytes > maxBuffer) {
          outputLimitExceeded = `Git command stderr exceeded maxBuffer of ${maxBuffer} bytes`;
        } else {
          stderr += text;
        }
      }
      if (outputLimitExceeded && !termination) {
        termination = process.terminate();
        void termination.catch(() => undefined);
      }
    };
    const onAbort = () => {
      if (termination) return;
      cancelled = true;
      termination = process.terminate();
      void termination.catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    process.child.stdout?.on('data', (data: Buffer) => appendOutput('stdout', data));
    process.child.stderr?.on('data', (data: Buffer) => appendOutput('stderr', data));
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        termination = process.terminate();
        void termination.catch(() => undefined);
      }, options.timeoutMs);
    }
    try {
      const exit = await Promise.race([
        process.closed,
        process.failedTermination.then((error) => Promise.reject(error)),
      ]);
      if (process.termination) {
        await process.termination;
      }
      if (timedOut) {
        return {
          stdout,
          stderr: `Git command timed out after ${options.timeoutMs}ms`,
          exitCode: 1,
        };
      }
      if (cancelled) {
        return {
          stdout,
          stderr: stderr || 'Git process was cancelled',
          exitCode: 1,
        };
      }
      if (outputLimitExceeded) {
        return {
          stdout,
          stderr: outputLimitExceeded,
          exitCode: 1,
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        };
      }
      if (exit.error) return processFailure(exit.error);
      return {
        stdout,
        stderr: stderr || (exit.signal ? `Git terminated by ${exit.signal}` : ''),
        exitCode: exit.code ?? 1,
      };
    } catch (error) {
      return processFailure(error instanceof Error ? error : new Error(String(error)));
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void process.closed.then(forgetProcess);
      void process.failedTermination.then(forgetProcess);
    }
  };

  return Object.freeze({ execGit });
};

export const { execGit } = createGitProcessRuntime();
