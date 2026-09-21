import { execFile, spawn, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;

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
    cause,
    rootError: rootError || undefined,
  },
);

// Each background command gets its own POSIX group. Never signal the extension
// host's group, which can also contain unrelated extensions and editor work.
export function spawnOwnedProcess(binary: string, args: string[], options: Pick<SpawnOptions, 'cwd' | 'env'>) {
  const child = spawn(binary, args, {
    ...options,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    detached: process.platform !== 'win32',
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
    if (childClosed || child.exitCode !== null && child.exitCode !== undefined
      || child.signalCode !== null && child.signalCode !== undefined) {
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
    try { process.kill(-child.pid, signal); }
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
      if (process.platform === 'win32') {
        let taskkillError: Error | null = null;
        if (!childClosed && child.exitCode == null && child.signalCode == null) {
          // Keep the parent alive until Windows has enumerated its descendants.
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
        }
        if (taskkillError) {
          const rootError = killRoot();
          const rootClosed = await waitForClose(WINDOWS_TERMINATION_TIMEOUT_MS);
          throw terminationFailure(child.pid, taskkillError, rootError, rootClosed);
        }
      } else {
        signalGroup('SIGTERM');
        await waitForClose(1000);
        // A parent can exit while a tool ignores SIGTERM or holds its pipes.
        signalGroup('SIGKILL');
      }
      if (!await waitForClose(WINDOWS_TERMINATION_TIMEOUT_MS)) {
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
