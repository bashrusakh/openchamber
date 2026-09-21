import { spawn as nodeSpawn } from 'node:child_process';

export { isGitProcessCleanupBlocked as isProcessTreeCleanupBlocked } from './execution-errors.js';

// A Git launcher can create descendants (Git for Windows is one example). Give
// every long-lived Git child its own group so cancellation never signals the
// server's unrelated work, then terminate that group/tree as one unit.
export const withProcessTreeOwnership = (options, platform = process.platform) => ({
  ...options,
  detached: platform !== 'win32',
});

const killRoot = (child) => {
  try {
    child?.kill?.('SIGKILL');
    return null;
  } catch (error) {
    // The process may already have exited.
    return error;
  }
};

const WINDOWS_TERMINATION_TIMEOUT_MS = 5_000;

const observeChildClose = (child) => {
  if (!child?.pid || child.exitCode !== null && child.exitCode !== undefined
    || child.signalCode !== null && child.signalCode !== undefined) {
    return {
      promise: Promise.resolve(true),
      cancel: () => {},
    };
  }
  if (!child.once) {
    return {
      promise: Promise.resolve(false),
      cancel: () => {},
    };
  }

  let settled = false;
  let resolveClose;
  const promise = new Promise((resolve) => {
    resolveClose = resolve;
  });
  const onClose = () => {
    if (settled) return;
    settled = true;
    child.removeListener?.('close', onClose);
    resolveClose(true);
  };
  child.once('close', onClose);

  return {
    promise,
    cancel: () => {
      if (settled) return;
      settled = true;
      child.removeListener?.('close', onClose);
    },
  };
};

const confirmChildClose = (observation, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  let timer;
  const finish = (closed) => {
    if (settled) return;
    settled = true;
    if (timer) clearTimeout(timer);
    observation.cancel();
    resolve(closed);
  };
  void observation.promise.then((closed) => finish(closed));
  timer = setTimeout(() => finish(false), timeoutMs);
  timer?.unref?.();
});

const processTreeTerminationError = (pid, cause, rootError, rootClosed) => Object.assign(
  new Error(
    `Failed to terminate the Windows process tree for PID ${pid}; `
    + 'descendant termination was not confirmed',
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

const failWindowsTermination = async (child, pid, cause, timeoutMs, observation = observeChildClose(child)) => {
  const rootError = killRoot(child);
  const rootClosed = await confirmChildClose(observation, timeoutMs);
  throw processTreeTerminationError(pid, cause, rootError, rootClosed);
};

const confirmSuccessfulWindowsTermination = async (child, pid, timeoutMs, observation) => {
  const rootClosed = await confirmChildClose(observation, timeoutMs);
  if (rootClosed) return;
  throw processTreeTerminationError(
    pid,
    new Error(`Windows process tree for PID ${pid} did not close within ${timeoutMs}ms after taskkill`),
    null,
    false,
  );
};

export const killProcessTree = (
  child,
  {
    spawn = nodeSpawn,
    platform = process.platform,
    terminationTimeoutMs = WINDOWS_TERMINATION_TIMEOUT_MS,
  } = {},
) => {
  if (!child?.pid) {
    killRoot(child);
    return Promise.resolve();
  }

  if (platform === 'win32') {
    const observation = observeChildClose(child);
    let taskkill;
    try {
      taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch (error) {
      return failWindowsTermination(child, child.pid, error, terminationTimeoutMs, observation);
    }

    if (!taskkill) {
      return failWindowsTermination(
        child,
        child.pid,
        new Error('Windows taskkill did not start'),
        terminationTimeoutMs,
        observation,
      );
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      let timer;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        void confirmSuccessfulWindowsTermination(child, child.pid, terminationTimeoutMs, observation)
          .then(resolve, reject);
      };
      const fail = (cause) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        void failWindowsTermination(child, child.pid, cause, terminationTimeoutMs, observation)
          .then(resolve, reject);
      };
      try {
        taskkill.on('error', (error) => fail(error));
        taskkill.on('close', (code) => {
          if (code === 0) {
            finish();
            return;
          }
          fail(new Error(`taskkill exited with code ${code}`));
        });
        timer = setTimeout(() => fail(new Error(
          `taskkill did not finish within ${terminationTimeoutMs}ms`,
        )), terminationTimeoutMs);
        timer?.unref?.();
      } catch (error) {
        fail(error);
      }
    });
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      killRoot(child);
    }
  }
  return Promise.resolve();
};

const createOutputLimitError = (stream, maxBuffer) => Object.assign(
  new Error(`${stream} maxBuffer length exceeded`),
  { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' },
);

// execFile's built-in timeout and maxBuffer handling only kills its root
// process. Keep the same text-process contract while making timeout, abort,
// and output-limit cleanup use the shared tree lifecycle.
export const execFileProcessTree = ({
  command,
  args,
  cwd,
  env,
  windowsHide = true,
  timeout = 0,
  maxBuffer = Infinity,
  idleTimeout = 0,
  signal,
  spawn = nodeSpawn,
  platform = process.platform,
  terminationTimeoutMs = WINDOWS_TERMINATION_TIMEOUT_MS,
}) => new Promise((resolve, reject) => {
  let child;
  try {
    child = spawn(command, args, withProcessTreeOwnership({
      cwd,
      env,
      windowsHide,
      stdio: ['ignore', 'pipe', 'pipe'],
    }, platform));
  } catch (error) {
    reject(error);
    return;
  }

  let stdout = '';
  let stderr = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let settled = false;
  let termination;
  let terminationError;
  let timer;
  let idleTimer;

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    if (idleTimer) clearTimeout(idleTimer);
    signal?.removeEventListener('abort', onAbort);
  };
  const withTerminationFailure = (error, failure) => {
    if (failure) {
      failure.operationError = error || undefined;
      failure.descendantsTerminated = false;
      return failure;
    }
    return error;
  };
  const finish = async (error, result) => {
    if (settled) return;
    settled = true;
    cleanup();
    try {
      await termination;
    } catch (failure) {
      const result = withTerminationFailure(error, failure);
      if (error) {
        result.stdout = stdout;
        result.stderr = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.message : stderr;
      }
      reject(result);
      return;
    }
    if (error) {
      error.stdout = stdout;
      error.stderr = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.message : stderr;
      reject(error);
      return;
    }
    resolve(result);
  };
  const requestTermination = (error) => {
    if (termination) return;
    terminationError = error;
    try {
      termination = killProcessTree(child, { spawn, platform, terminationTimeoutMs });
    } catch (failure) {
      termination = Promise.reject(failure);
    }
    void termination.catch(() => finish(error));
  };
  const append = (stream, chunk) => {
    const text = chunk.toString();
    if (idleTimeout > 0) {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => requestTermination(
        Object.assign(new Error(`Command produced no output for ${idleTimeout}ms`), { code: 'ETIMEDOUT' }),
      ), idleTimeout);
    }
    if (stream === 'stdout') {
      stdoutBytes += Buffer.byteLength(text);
      if (stdoutBytes > maxBuffer) {
        requestTermination(createOutputLimitError('stdout', maxBuffer));
        return;
      }
      stdout += text;
      return;
    }
    stderrBytes += Buffer.byteLength(text);
    if (stderrBytes > maxBuffer) {
      requestTermination(createOutputLimitError('stderr', maxBuffer));
      return;
    }
    stderr += text;
  };
  const onAbort = () => requestTermination(
    Object.assign(new Error('The Git process was aborted'), { code: 'ABORT_ERR' }),
  );

  child.stdout?.on('data', (chunk) => append('stdout', chunk));
  child.stderr?.on('data', (chunk) => append('stderr', chunk));
  child.on('error', (error) => { void finish(terminationError || error); });
  child.on('close', (code, signalCode) => {
    if (terminationError) {
      void finish(terminationError);
      return;
    }
    if (code === 0) {
      void finish(null, { stdout, stderr });
      return;
    }
    void finish(Object.assign(
      new Error(stderr.trim() || `Command failed with exit code ${code}`),
      { code: code ?? 1, signal: signalCode },
    ));
  });

  if (timeout > 0) {
    timer = setTimeout(() => requestTermination(
      Object.assign(new Error(`Command timed out after ${timeout}ms`), { code: 'ETIMEDOUT' }),
    ), timeout);
  }
  if (signal?.aborted) {
    onAbort();
    return;
  }
  signal?.addEventListener('abort', onAbort, { once: true });
  if (idleTimeout > 0) {
    idleTimer = setTimeout(() => requestTermination(
      Object.assign(new Error(`Command produced no output for ${idleTimeout}ms`), { code: 'ETIMEDOUT' }),
    ), idleTimeout);
  }
});
