import net from 'node:net';
import path from 'node:path';
import { GuardianClient } from './guardian-client.js';
import { resolveManagedOpenCodeHandoffV2Root } from '../opencode/managed-opencode-handoff-v2/filesystem.js';

const DEFAULT_CONNECT_TIMEOUT_MS = 100;

export function getGuardianSocketPath(rootDir) {
  return path.join(resolveManagedOpenCodeHandoffV2Root(rootDir), 'guardian.sock');
}

export function isGuardianRunning(socketPath) {
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, DEFAULT_CONNECT_TIMEOUT_MS);

    socket.once('connect', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(true);
    });

    socket.once('error', () => {
      clearTimeout(timer);
      socket.destroy();
      resolve(false);
    });
  });
}

export async function detectAndAdoptGuardianChild(socketPath) {
  if (process.platform === 'win32') {
    return null;
  }

  const targetSocketPath = socketPath ?? getGuardianSocketPath();

  const running = await isGuardianRunning(targetSocketPath);
  if (!running) {
    return null;
  }

  const client = new GuardianClient({ socketPath: targetSocketPath, connectTimeoutMs: 500 });
  try {
    await client.connect();
    const children = await client.list();
    if (!Array.isArray(children) || children.length === 0) {
      return null;
    }

    // Find the first active child with identity.
    const activeChild = children.find((child) =>
      child.state === 'active' && child.pid && child.port
    );
    if (!activeChild) {
      return null;
    }

    return {
      incarnation: activeChild.incarnation,
      pid: activeChild.pid,
      port: activeChild.port,
      url: `http://127.0.0.1:${activeChild.port}`,
    };
  } catch {
    return null;
  } finally {
    try {
      client.disconnect();
    } catch {
      // Ignore.
    }
  }
}
