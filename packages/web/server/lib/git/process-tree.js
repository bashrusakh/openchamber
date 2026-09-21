import { spawn as nodeSpawn } from 'node:child_process';

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
  } catch {
    // The process may already have exited.
  }
};

export const killProcessTree = (
  child,
  { spawn = nodeSpawn, platform = process.platform } = {},
) => {
  if (!child?.pid) {
    killRoot(child);
    return Promise.resolve();
  }

  if (platform === 'win32') {
    let taskkill;
    try {
      taskkill = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
    } catch {
      killRoot(child);
      return Promise.resolve();
    }

    if (!taskkill) {
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      taskkill.on('error', () => {
        killRoot(child);
        finish();
      });
      taskkill.on('close', finish);
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
  signal,
  spawn = nodeSpawn,
  platform = process.platform,
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

  const cleanup = () => {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  };
  const requestTermination = (error) => {
    if (termination) return;
    terminationError = error;
    termination = killProcessTree(child, { spawn, platform });
  };
  const finish = async (error, result) => {
    if (settled) return;
    settled = true;
    cleanup();
    await termination;
    if (error) {
      error.stdout = stdout;
      error.stderr = error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? error.message : stderr;
      reject(error);
      return;
    }
    resolve(result);
  };
  const append = (stream, chunk) => {
    const text = chunk.toString();
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
});
