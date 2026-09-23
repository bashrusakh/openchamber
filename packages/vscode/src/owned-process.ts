import { execFile, spawn, type SpawnOptions } from 'node:child_process';

type ProcessExit = { code: number | null; signal: NodeJS.Signals | null; error: Error | null };
const WINDOWS_TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_TERMINATION_TIMEOUT_MS = 1_000;
const POSIX_TERMINATION_GRACE_MS = 1_000;
const POSIX_GROUP_POLL_MS = 10;

type ProcessKill = (pid: number, signal?: NodeJS.Signals | number) => void;
type CleanupReconciliation = {
  promise: Promise<unknown>;
  retire: () => void;
};
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
  cleanupReconciliation?: CleanupReconciliation,
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
    cleanupReconciliation,
  },
);

const observeProcessGroupGone = (pid: number, processKill: ProcessKill) => {
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveGone: (gone: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => { resolveGone = resolve; });
  const finish = (gone: boolean) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveGone(gone);
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
    timer = setTimeout(check, POSIX_GROUP_POLL_MS);
  };
  check();
  return { promise, cancel: () => finish(false) };
};

const observeWindowsTreeCleanup = (pid: number, closed: Promise<ProcessExit>) => {
  let settled = false;
  let started = false;
  let failed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let resolveCleanup: (confirmed: boolean) => void = () => undefined;
  const promise = new Promise<boolean>((resolve) => { resolveCleanup = resolve; });
  const finish = (confirmed: boolean) => {
    if (settled || failed) return;
    settled = true;
    if (timer) clearTimeout(timer);
    resolveCleanup(confirmed);
  };
  const confirm = () => {
    if (settled || started) return;
    started = true;
    try {
      // A closed root does not prove that a Windows descendant is gone. A
      // late tree termination attempt is the only confirmation available to
      // this owner once the original taskkill request has failed.
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        timeout: WINDOWS_TASKKILL_TIMEOUT_MS,
      }, (error) => {
        if (error) {
          failed = true;
          if (timer) clearTimeout(timer);
          return;
        }
        finish(true);
      });
      timer = setTimeout(() => {
        if (settled || failed) return;
        failed = true;
      }, WINDOWS_TASKKILL_TIMEOUT_MS);
      timer.unref?.();
    } catch {
      failed = true;
    }
  };
  void closed.then(confirm);
  return {
    promise,
    retire: () => {
      failed = true;
      if (timer) clearTimeout(timer);
    },
  };
};

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
          throw terminationFailure(
            child.pid,
            taskkillError,
            rootError,
            rootClosed,
            undefined,
            observeWindowsTreeCleanup(child.pid, closed),
          );
        }
      } else {
        const groupObservation = observeProcessGroupGone(child.pid, processKill);
        try {
          signalGroup('SIGTERM');
          await waitForClose(terminationGraceMs);
          // A parent can exit while a tool ignores SIGTERM or holds its pipes.
          signalGroup('SIGKILL');
          const rootClosed = await waitForClose(terminationTimeoutMs);
          const groupGone = rootClosed
            ? await Promise.race([
                groupObservation.promise,
                new Promise<boolean>((resolve) => {
                  const timer = setTimeout(() => resolve(false), terminationTimeoutMs);
                  timer.unref?.();
                }),
              ])
            : false;
          if (rootClosed && groupGone) return;
          throw terminationFailure(
            child.pid,
            new Error(`POSIX process group for PID ${child.pid} did not close after SIGKILL`),
            null,
            rootClosed,
            `Failed to terminate the POSIX process tree for PID ${child.pid}; descendant termination was not confirmed`,
            {
              promise: Promise.all([closed, groupObservation.promise]),
              retire: () => groupObservation.cancel(),
            },
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
            {
              promise: Promise.all([closed, groupObservation.promise]),
              retire: () => groupObservation.cancel(),
            },
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
