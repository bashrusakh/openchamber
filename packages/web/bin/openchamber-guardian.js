#!/usr/bin/env node

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createManagedOpenCodeGuardian } from '../server/lib/guardian/guardian.js';

const PID_DIR = path.join(os.homedir(), '.local', 'state', 'openchamber');
const PID_FILE = path.join(PID_DIR, 'guardian.pid');

const parseArgs = (argv) => {
  const args = {
    socketPath: undefined,
    dataDir: undefined,
    healthInterval: undefined,
    leaseInterval: undefined,
  };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--socket-path' && i + 1 < argv.length) {
      args.socketPath = argv[i + 1];
      i += 1;
    } else if (arg === '--data-dir' && i + 1 < argv.length) {
      args.dataDir = argv[i + 1];
      i += 1;
    } else if (arg === '--health-interval' && i + 1 < argv.length) {
      args.healthInterval = Number.parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg === '--lease-interval' && i + 1 < argv.length) {
      args.leaseInterval = Number.parseInt(argv[i + 1], 10);
      i += 1;
    }
  }
  return args;
};

const readPidFile = () => {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    return Number.isFinite(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
};

const writePidFile = (pid) => {
  fs.mkdirSync(PID_DIR, { recursive: true });
  try {
    const fd = fs.openSync(PID_FILE, 'wx', 0o600);
    fs.writeFileSync(fd, String(pid));
    fs.closeSync(fd);
  } catch (error) {
    if (error?.code === 'EEXIST') {
      // Another process may have created the file concurrently.
      const existingPid = readPidFile();
      if (existingPid && isProcessAlive(existingPid)) {
        console.error(`Guardian is already running (pid ${existingPid})`);
        process.exit(1);
      }
      // Stale PID file; remove and retry once.
      try {
        fs.unlinkSync(PID_FILE);
      } catch {
        // Ignore unlink errors.
      }
      const fd = fs.openSync(PID_FILE, 'wx', 0o600);
      fs.writeFileSync(fd, String(pid));
      fs.closeSync(fd);
    } else {
      throw error;
    }
  }
};

const removePidFile = () => {
  try {
    fs.unlinkSync(PID_FILE);
  } catch {
    // Ignore.
  }
};

const isProcessAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const enforceSingleton = () => {
  const existingPid = readPidFile();
  if (existingPid && isProcessAlive(existingPid)) {
    console.error(`Guardian is already running (pid ${existingPid})`);
    process.exit(1);
  }
};

const main = async () => {
  if (process.platform === 'win32') {
    console.error('Guardian is Linux/POSIX only');
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  enforceSingleton();
  writePidFile(process.pid);

  const guardian = createManagedOpenCodeGuardian({
    rootDir: args.dataDir,
    socketPath: args.socketPath,
    healthCheckIntervalMs: args.healthInterval,
    leaseRenewalIntervalMs: args.leaseInterval,
  });

  const shutdown = async (signal) => {
    console.log(`[guardian-cli] received ${signal}, shutting down...`);
    try {
      await guardian.stop();
    } catch (error) {
      console.error('[guardian-cli] shutdown error:', error.message);
    } finally {
      removePidFile();
    }
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => {
    console.log('[guardian-cli] received SIGHUP, reloading config...');
    // Config reload is a no-op in Phase 2B; timers restart with current values.
    guardian.stopTimers();
    guardian.startTimers();
  });

  try {
    await guardian.start();
  } catch (error) {
    console.error('[guardian-cli] failed to start:', error.message);
    removePidFile();
    process.exit(1);
  }

  // Block until stopped.
  await new Promise(() => {});
};

main().catch((error) => {
  console.error('[guardian-cli] fatal error:', error);
  removePidFile();
  process.exit(1);
});
