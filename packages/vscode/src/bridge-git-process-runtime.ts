import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn, execFile } from 'child_process';
import { promisify } from 'util';
import { getGitExecutablePath } from './gitService';
import { getGitExecutionEnv } from './git-execution-scope';

const execFileAsync = promisify(execFile);
const gpgconfCandidates = ['gpgconf', '/opt/homebrew/bin/gpgconf', '/usr/local/bin/gpgconf'];

export type GitProcessRuntimeOptions = {
  resolveGitExecutable?: () => Promise<string | undefined>;
};

const isSocketPath = async (candidate: string): Promise<boolean> => {
  if (!candidate) {
    return false;
  }
  try {
    const stat = await fs.promises.stat(candidate);
    return typeof stat.isSocket === 'function' && stat.isSocket();
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
  const execGit = async (args: string[], cwd: string): Promise<{ stdout: string; stderr: string; exitCode: number; code?: string }> => {
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
    const gitExecutable = configuredPath?.trim() || 'git';

    return new Promise((resolve) => {
      const proc = spawn(gitExecutable, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...env, ...getGitExecutionEnv() },
        windowsHide: true,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('close', (code) => {
        resolve({ stdout, stderr, exitCode: code ?? 0 });
      });

      proc.on('error', (error) => {
        resolve(processFailure(error));
      });
    });
  };

  return Object.freeze({ execGit });
};

export const { execGit } = createGitProcessRuntime();
