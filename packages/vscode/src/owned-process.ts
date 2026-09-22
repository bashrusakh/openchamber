import { execFile, spawn, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const POSIX_TERMINATION_GRACE_MS = 1_000;
const POSIX_GROUP_POLL_MS = 10;

type ProcessKill = (pid: number, signal?: NodeJS.Signals | number) => void;
type OwnedProcessDependencies = {
  platform?: NodeJS.Platform;
  processKill?: ProcessKill;
  terminationTimeoutMs?: number;
  terminationGraceMs?: number;
};

const terminationFailure = (
  pid: number,
  cause: unknown,
  rootError: Error | null,
  rootClosed: boolean,
  message = `Failed to terminate the Windows process tree for PID ${pid}; descendant termination was not confirmed`,
) => Object.assign(
  new Error(
    message,
  ),
  {
    code: 'ERR_PROCESS_TREE_TERMINATION',
    pid,
    descendantsTerminated: false,
    cleanupBlocked: true,
    rootClosed,
    cause: cause instanceof Error ? cause : String(cause),
    rootError: rootError || undefined,
  },
);

const confirmProcessGroupGone = (
  pid: number,
  timeoutMs: number,
  processKill: ProcessKill,
) => new Promise<boolean>((resolve) => {
  const startedAt = Date.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const finish = (confirmed: boolean) => {
    if (timer) clearTimeout(timer);
    resolve(confirmed);
  };
  const check = () => {
    try {
      processKill(-pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH') {
        finish(true);
        return;
      }
    }
    if (Date.now() - startedAt >= timeoutMs) {
      finish(false);
      return;
    }
    timer = setTimeout(check, POSIX_GROUP_POLL_MS);
  };
  check();
});

// Each background command gets its own POSIX group. Never signal the extension
// host's group, which can also contain unrelated extensions and editor work.
export function spawnOwnedProcess(
  binary: string,
  args: string[],
  options: Pick<SpawnOptions, 'cwd' | 'env'>,
  dependencies: OwnedProcessDependencies = {},
) {
  const platform = dependencies.platform || process.platform;
  const processKill: ProcessKill = dependencies.processKill || ((pid, signal) => process.kill(pid, signal));
  const terminationTimeoutMs = dependencies.terminationTimeoutMs ?? WINDOWS_TERMINATION_TIMEOUT_MS;
  const terminationGraceMs = dependencies.terminationGraceMs ?? POSIX_TERMINATION_GRACE_MS;
  const child = spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: platform !== 'win32',
  });
  let spawnError: Error | null = null;
  let childClosed = false;
  const closed = new Promise<ProcessExit>((resolve) => {
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code, signal) => {
      childClosed = true;
      resolve({ code, signal, error: spawnError });
    });
  });
  const waitForClose = async (timeoutMs: number) => {
    if (childClosed) {
      return true;
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };
  const signalGroup = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try { processKill(-child.pid, signal); }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
    }
  };
  const killRoot = (): Error | null => {
    try {
      child.kill('SIGKILL');
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
  };
  let reportTerminationFailure: (error: Error) => void = () => undefined;
  const failedTermination = new Promise<Error>((resolve) => {
    reportTerminationFailure = resolve;
  });
  let termination: Promise<void> | null = null;
  const terminate = () => {
    if (termination) return termination;
    termination = (async () => {
      if (!child.pid) {
        // Test doubles and a child that failed before receiving a pid may still
        // expose a kill method; ask them to close so cancellation settles only
        // after the same close event as a real child.
        try { child.kill('SIGKILL'); } catch { /* already closed */ }
        await closed;
        return;
      }
      if (platform === 'win32') {
        let taskkillError: Error | null = null;
        // Root close is not evidence that a Windows descendant tree is gone.
        // Keep taskkill independent of the root lifecycle so a child that
        // outlives Git is still terminated and its cleanup is awaited.
        try {
          await new Promise<void>((resolve) => {
            execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
              windowsHide: true, timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
            }, (error) => {
              taskkillError = error || null;
              resolve();
            });
          });
        } catch (error) {
          taskkillError = error instanceof Error ? error : new Error(String(error));
        }
        if (taskkillError) {
          const rootError = killRoot();
          const rootClosed = await waitForClose(WINDOWS_TERMINATION_TIMEOUT_MS);
          throw terminationFailure(child.pid, taskkillError, rootError, rootClosed);
        }
      } else {
        try {
          signalGroup('SIGTERM');
          await waitForClose(terminationGraceMs);
          // A parent can exit while a tool ignores SIGTERM or holds its pipes.
          signalGroup('SIGKILL');
          const rootClosed = await waitForClose(terminationTimeoutMs);
          const groupGone = rootClosed && child.pid
            ? await confirmProcessGroupGone(child.pid, terminationTimeoutMs, processKill)
            : false;
          if (rootClosed && groupGone) return;
          throw terminationFailure(
            child.pid,
            new Error(`POSIX process group for PID ${child.pid} did not close after SIGKILL`),
            null,
            rootClosed,
            `Failed to terminate the POSIX process tree for PID ${child.pid}; descendant termination was not confirmed`,
          );
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ERR_PROCESS_TREE_TERMINATION') throw error;
          const rootError = killRoot();
          const rootClosed = await waitForClose(terminationTimeoutMs);
          throw terminationFailure(
            child.pid,
            error,
            rootError,
            rootClosed,
            `Failed to terminate the POSIX process tree for PID ${child.pid}; descendant termination was not confirmed`,
          );
        }
      }
      if (!await waitForClose(terminationTimeoutMs)) {
        throw terminationFailure(
          child.pid,
          new Error('Owned process did not close after termination'),
          null,
          false,
          `Failed to terminate owned process PID ${child.pid}; process close was not confirmed`,
        );
      }
    })();
    void termination.catch((error) => {
      reportTerminationFailure(error instanceof Error ? error : new Error(String(error)));
    });
    return termination;
  };
  return {
    child,
    closed,
    terminate,
    failedTermination,
    get termination() { return termination; },
  };
}
