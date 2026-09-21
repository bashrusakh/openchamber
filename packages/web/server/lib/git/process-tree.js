import { spawn as nodeSpawn } from 'node:child_process';

// A Git launcher can create descendants (Git for Windows is one example). Give
// every long-lived Git child its own group so cancellation never signals the
// server's unrelated work, then terminate that group/tree as one unit.
export const withProcessTreeOwnership = (options, platform = process.platform) => ({
  ...options,
  detached: platform !== 'win32',
});

export const killProcessTree = (
  child,
  { spawn = nodeSpawn, platform = process.platform } = {},
) => {
  if (!child?.pid) {
    try {
      child?.kill?.('SIGKILL');
    } catch {
      // The process may already have exited.
    }
    return;
  }

  if (platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      }).on('error', () => {});
    } catch {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
    return;
  }

  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) {
      try {
        child.kill('SIGKILL');
      } catch {
        // The process may already have exited.
      }
    }
  }
};
