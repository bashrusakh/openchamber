/**
 * Spawns the pinned local `opencode serve` binary against the mock provider.
 *
 * Isolation rules for the probe:
 * - the server runs with HOME/XDG_* pointed at a throwaway directory, so it
 *   cannot read the developer's real OpenCode auth, sessions, or config;
 * - the provider is a localhost mock with a literal fake key, so no real
 *   credentials and no external network are involved;
 * - `OPENCODE_CONFIG_CONTENT` carries the whole config inline.
 */

import { spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

async function freePort() {
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response('') });
  const port = server.port;
  await server.stop(true);
  return port;
}

export function createIsolatedHome(root) {
  const home = path.join(root, 'home');
  const dirs = {
    home,
    data: path.join(home, '.local', 'share'),
    config: path.join(home, '.config'),
    cache: path.join(home, '.cache'),
    state: path.join(home, '.local', 'state'),
  };
  for (const dir of Object.values(dirs)) {
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  }
  return {
    ...dirs,
    env: {
      HOME: dirs.home,
      XDG_DATA_HOME: dirs.data,
      XDG_CONFIG_HOME: dirs.config,
      XDG_CACHE_HOME: dirs.cache,
      XDG_STATE_HOME: dirs.state,
    },
  };
}

/**
 * The probe may itself run inside a managed OpenChamber/OpenCode session, whose
 * environment (server password, agent-tool token, inline config, plugin list)
 * would leak into a spawned child. Build a clean env: drop every OPENCODE_* and
 * OPENCHAMBER_* variable, then add only the probe's own values.
 */
function scrubManagedEnv(source) {
  const env = {};
  for (const [key, value] of Object.entries(source)) {
    if (key.startsWith('OPENCODE_') || key.startsWith('OPENCHAMBER_')) continue;
    env[key] = value;
  }
  return env;
}

export async function startOpencodeServer({ binary, cwd, config, isolatedHome, timeoutMs = 45000 }) {
  const port = await freePort();
  const logs = [];
  const child = spawn(
    binary,
    ['serve', '--hostname', '127.0.0.1', '--port', String(port), '--print-logs', '--pure'],
    {
      cwd,
      env: {
        ...scrubManagedEnv(process.env),
        ...isolatedHome.env,
        OPENCODE_CONFIG_CONTENT: JSON.stringify(config),
        OPENCODE_DISABLE_AUTOUPDATE: '1',
        OPENCODE_DISABLE_MODELS_FETCH: '1',
        OPENCODE_DISABLE_PROJECT_CONFIG: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );

  const append = (chunk) => {
    const text = String(chunk);
    logs.push(text);
    if (logs.length > 400) logs.splice(0, logs.length - 400);
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);

  const baseUrl = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + timeoutMs;
  let healthy = false;
  let lastError = '';
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`opencode serve exited early (code ${child.exitCode}):\n${logs.join('')}`);
    }
    try {
      const response = await fetch(`${baseUrl}/global/health`, {
        signal: AbortSignal.timeout(1500),
      });
      if (response.ok) {
        healthy = true;
        break;
      }
      lastError = `health ${response.status}`;
    } catch (error) {
      lastError = String(error);
    }
    await Bun.sleep(200);
  }
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`opencode serve did not become healthy at ${baseUrl} (${lastError}):\n${logs.join('')}`);
  }

  return {
    baseUrl,
    port,
    logs,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill('SIGTERM');
      const deadlineStop = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadlineStop) {
        await Bun.sleep(100);
      }
      if (child.exitCode === null) child.kill('SIGKILL');
    },
  };
}
