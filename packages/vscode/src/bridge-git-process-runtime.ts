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

const getErrorCode = (error: unknown): string | undefined => {
  if (!error || typeof error !== 'object' || !('code' in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === 'string' ? code : undefined;
};

const processFailure = (error: unknown): { stdout: string; stderr: string; exitCode: number; code?: string } => ({
  stdout: '',
  stderr: error instanceof Error ? error.message : String(error),
  exitCode: 1,
  code: getErrorCode(error),
});

export const createGitProcessRuntime = ({
  resolveGitExecutable = getGitExecutablePath,
}: GitProcessRuntimeOptions = {}) => {
  const execGit = async (
    args: string[],
    cwd: string,
    options: GitProcessExecutionOptions = {},
  ): Promise<{ stdout: string; stderr: string; exitCode: number; code?: string }> => {
    let env: NodeJS.ProcessEnv;
    let configuredPath: string | undefined;
    try {
      [env, configuredPath] = await Promise.all([
        buildGitEnv(),
        resolveGitExecutable(),
      ]);
    } catch (error) {
      return processFailure(error);
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
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let cancelled = false;
    let termination: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      if (termination) return;
      cancelled = true;
      termination = process.terminate();
      void termination.catch(() => undefined);
    };
    options.signal?.addEventListener('abort', onAbort, { once: true });
    process.child.stdout?.on('data', (data: Buffer) => { stdout += data.toString(); });
    process.child.stderr?.on('data', (data: Buffer) => { stderr += data.toString(); });
    try {
      const exit = await new Promise<Awaited<typeof process.closed>>((resolve, reject) => {
        void process.closed.then(resolve);
        if (options.timeoutMs && options.timeoutMs > 0) {
          timer = setTimeout(() => {
            timedOut = true;
            termination = process.terminate();
            void termination.catch(reject);
          }, options.timeoutMs);
        }
      });
      await termination;
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
      if (exit.error) return processFailure(exit.error);
      return {
        stdout,
        stderr: stderr || (exit.signal ? `Git terminated by ${exit.signal}` : ''),
        exitCode: exit.code ?? 1,
      };
    } catch (error) {
      return processFailure(error);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      void process.closed.then(() => activeProcesses.delete(process));
    }
  };

  return Object.freeze({ execGit });
};

export const { execGit } = createGitProcessRuntime();
