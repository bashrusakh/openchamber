import http from 'node:http';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDirectoryActivityRuntime } from './directory-activity-runtime.js';
import { createIdleInstanceReaper } from './idle-instance-reaper.js';
import { createGracefulShutdownRuntime } from './shutdown-runtime.js';

const IDLE_WINDOW_MS = 30 * 60 * 1000;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;

const createClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const sendJson = (res, status, payload) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(payload));
};

const listen = (server) => new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    server.removeListener('error', reject);
    resolve(server.address().port);
  });
});

const createDeferred = () => {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
};

const closeServer = (server) => new Promise((resolve) => {
  server.closeAllConnections?.();
  server.close(() => resolve());
});

/**
 * Real HTTP fake upstream. Handlers receive the request directory so a test can
 * vary one directory at a time; everything unhandled answers like a healthy,
 * idle OpenCode server.
 */
const createFakeUpstream = (handlers = {}) => {
  const calls = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
    const directory = url.searchParams.get('directory');
    calls.push({ method: req.method, path: url.pathname, directory });

    const handler = handlers[url.pathname];
    if (handler) {
      handler(req, res, directory);
      return;
    }

    if (url.pathname === '/session/status') return sendJson(res, 200, {});
    if (url.pathname === '/permission') return sendJson(res, 200, []);
    if (url.pathname === '/question') return sendJson(res, 200, []);
    if (url.pathname === '/instance/dispose') return sendJson(res, 200, { disposed: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return { server, calls };
};

const openHarnesses = [];

const createHarness = async (overrides = {}) => {
  const upstream = createFakeUpstream(overrides.upstreamHandlers);
  const port = await listen(upstream.server);
  const clock = overrides.clock ?? createClock();
  const tracker = overrides.tracker ?? createDirectoryActivityRuntime({
    now: clock.now,
    realpath: async (value) => value,
  });
  const portRef = overrides.portRef ?? { value: port };
  portRef.value = port;
  const logs = { log: [], warn: [], debug: [] };

  const reaper = createIdleInstanceReaper({
    tracker,
    readSettings: async () => ({ idleInstanceTimeoutMs: IDLE_WINDOW_MS }),
    hasQueuedWork: () => false,
    getOpenCodePort: () => portRef.value,
    isManagedOpenCodeReady: () => true,
    isExternalOpenCode: () => false,
    isRestartingOpenCode: () => false,
    isShuttingDown: () => false,
    buildOpenCodeUrl: (path) => `http://127.0.0.1:${portRef.value}${path}`,
    getOpenCodeAuthHeaders: () => ({ Authorization: 'Basic dGVzdDp0ZXN0' }),
    env: {},
    now: clock.now,
    logger: {
      log: (line) => logs.log.push(line),
      warn: (line) => logs.warn.push(line),
      debug: (line) => logs.debug.push(line),
    },
    ...overrides.reaper,
  });

  const harness = {
    upstream,
    tracker,
    clock,
    logs,
    reaper,
    port,
    portRef,
    close: () => closeServer(upstream.server),
  };
  openHarnesses.push(harness);
  return harness;
};

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(openHarnesses.splice(0).map((harness) => harness.close()));
});

const observe = async (harness, directory) => {
  const release = await harness.tracker.observeRequest(directory);
  release();
};

const observeQuiet = async (harness, directory, quietMs = IDLE_WINDOW_MS) => {
  await observe(harness, directory);
  harness.clock.advance(quietMs);
};

const callPaths = (harness) => harness.upstream.calls.map((call) => call.path);

const disposeCalls = (harness) => harness.upstream.calls
  .filter((call) => call.path === '/instance/dispose')
  .map((call) => call.directory);

describe('createIdleInstanceReaper', () => {
  it('releases a quiet directory after all probes agree and removes the tracker entry', async () => {
    const harness = await createHarness();
    await observeQuiet(harness, '/repo/quiet');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([
      { method: 'GET', path: '/session/status', directory: '/repo/quiet' },
      { method: 'GET', path: '/permission', directory: '/repo/quiet' },
      { method: 'GET', path: '/question', directory: '/repo/quiet' },
      { method: 'POST', path: '/instance/dispose', directory: '/repo/quiet' },
    ]);
    expect(harness.tracker.snapshot()).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
    expect(harness.logs.log).toEqual([
      `[instance-reaper] released /repo/quiet idleMs=${IDLE_WINDOW_MS}`,
      '[instance-reaper] sweep complete: released=1 failed=0 skipped=0',
    ]);
  });

  it('does not dispose while a session is busy, leaves the activity stamp untouched, and retries once idle', async () => {
    let busy = true;
    const harness = await createHarness({
      upstreamHandlers: {
        '/session/status': (req, res) => sendJson(res, 200, busy ? { ses_1: { type: 'busy' } } : {}),
      },
    });
    await observeQuiet(harness, '/repo/busy');
    const stampedAt = harness.tracker.snapshot()[0].lastActivityAt;

    await harness.reaper.runSweep();

    // A short-circuited busy probe is not activity and not a failure.
    expect(callPaths(harness)).toEqual(['/session/status']);
    expect(harness.tracker.snapshot()).toEqual([
      { directory: '/repo/busy', lastActivityAt: stampedAt, inflight: 0 },
    ]);
    expect(harness.logs.log).toEqual([]);
    expect(harness.logs.warn).toEqual([]);

    busy = false;
    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/busy']);
    expect(harness.tracker.snapshot()).toEqual([]);
  });

  it('does not dispose while a permission is pending', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        '/permission': (req, res) => sendJson(res, 200, [{ id: 'per_1' }]),
      },
    });
    await observeQuiet(harness, '/repo/permission');

    await harness.reaper.runSweep();

    expect(callPaths(harness)).toEqual(['/session/status', '/permission']);
    expect(disposeCalls(harness)).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.log).toEqual([]);
  });

  it('does not dispose while a question is pending', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        '/question': (req, res) => sendJson(res, 200, [{ id: 'que_1' }]),
      },
    });
    await observeQuiet(harness, '/repo/question');

    await harness.reaper.runSweep();

    expect(callPaths(harness)).toEqual(['/session/status', '/permission', '/question']);
    expect(disposeCalls(harness)).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
  });

  it('does not probe or dispose while the queue predicate reports work', async () => {
    const harness = await createHarness({ reaper: { hasQueuedWork: () => true } });
    await observeQuiet(harness, '/repo/queued');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.log).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('treats a 404 question endpoint as unsupported and lets the other probes decide', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        '/question': (req, res) => sendJson(res, 404, { error: 'not found' }),
      },
    });
    await observeQuiet(harness, '/repo/old-server');

    await harness.reaper.runSweep();

    expect(callPaths(harness)).toEqual([
      '/session/status',
      '/permission',
      '/question',
      '/instance/dispose',
    ]);
    expect(harness.tracker.snapshot()).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('skips only the candidate whose probe failed and keeps it with backoff', async () => {
    let permissionFails = true;
    const harness = await createHarness({
      upstreamHandlers: {
        '/permission': (req, res, directory) => {
          if (directory === '/repo/failing' && permissionFails) {
            return sendJson(res, 500, { error: 'boom' });
          }
          return sendJson(res, 200, []);
        },
      },
    });
    await observeQuiet(harness, '/repo/failing');
    await observeQuiet(harness, '/repo/healthy');

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/healthy']);
    expect(harness.tracker.snapshot().map((entry) => entry.directory)).toEqual(['/repo/failing']);
    expect(harness.logs.warn).toEqual([
      '[instance-reaper] probe failed for /repo/failing (/permission status 500); retry after 300000ms',
    ]);
    expect(harness.logs.log).toEqual([
      '[instance-reaper] released /repo/healthy idleMs=1800000',
      '[instance-reaper] sweep complete: released=1 failed=1 skipped=0',
    ]);

    // The failed directory is in backoff: the next sweep skips it before any
    // probe, so the healthy failure cannot affect later candidates either.
    const callsAfterFirstSweep = harness.upstream.calls.length;
    await harness.reaper.runSweep();
    expect(harness.upstream.calls).toHaveLength(callsAfterFirstSweep);

    permissionFails = false;
    harness.clock.advance(FAILURE_BACKOFF_MS);
    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toEqual(['/repo/healthy', '/repo/failing']);
    expect(harness.tracker.snapshot()).toEqual([]);
  });

  it('keeps the entry and backs off after a dispose failure, then releases after the backoff', async () => {
    let disposeStatus = 500;
    const harness = await createHarness({
      upstreamHandlers: {
        '/instance/dispose': (req, res) => sendJson(
          res,
          disposeStatus,
          disposeStatus === 200 ? { disposed: true } : { error: 'nope' },
        ),
      },
    });
    await observeQuiet(harness, '/repo/flaky');

    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toEqual(['/repo/flaky']);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.warn).toEqual([
      '[instance-reaper] dispose failed for /repo/flaky (status 500); retry after 300000ms',
    ]);

    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toHaveLength(1);

    disposeStatus = 200;
    harness.clock.advance(FAILURE_BACKOFF_MS);
    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toHaveLength(2);
    expect(harness.tracker.snapshot()).toEqual([]);
  });

  it('bounds a hanging dispose with the configured timeout and backs off', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        // Never respond: the reaper's dispose timeout must settle the sweep.
        '/instance/dispose': () => {},
      },
      reaper: { disposeTimeoutMs: 50 },
    });
    await observeQuiet(harness, '/repo/hang');

    const startedAt = Date.now();
    await harness.reaper.runSweep();
    const elapsedMs = Date.now() - startedAt;

    expect(elapsedMs).toBeLessThan(2000);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.warn).toEqual([
      '[instance-reaper] dispose failed for /repo/hang (transport timeout); retry after 300000ms',
    ]);
  });

  it('aborts the sweep when the managed port changes mid-sweep', async () => {
    const portRef = { value: 0 };
    const harness = await createHarness({
      portRef,
      upstreamHandlers: {
        '/instance/dispose': (req, res) => {
          sendJson(res, 200, { disposed: true });
          portRef.value = harness.port + 1;
        },
      },
    });
    await observeQuiet(harness, '/repo/one');
    await observeQuiet(harness, '/repo/two');

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/one']);
    expect(harness.upstream.calls.some((call) => call.directory === '/repo/two')).toBe(false);
    expect(harness.tracker.snapshot().map((entry) => entry.directory)).toEqual(['/repo/two']);
  });

  it('releases at most 10 candidates per sweep, oldest first', async () => {
    const harness = await createHarness();
    for (let index = 0; index < 12; index += 1) {
      await observeQuiet(harness, `/repo/dir-${String(index).padStart(2, '0')}`);
    }

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(
      Array.from({ length: 10 }, (_value, index) => `/repo/dir-${String(index).padStart(2, '0')}`),
    );
    expect(harness.tracker.snapshot().map((entry) => entry.directory)).toEqual([
      '/repo/dir-10',
      '/repo/dir-11',
    ]);
  });

  it('does not dispose a directory that acquires an in-flight request before the decision', async () => {
    const tracker = {
      listQuietDirectories: () => [{ directory: '/repo/racy', lastActivityAt: 0, inflight: 0 }],
      snapshot: () => [{ directory: '/repo/racy', lastActivityAt: 0, inflight: 1 }],
      matchesDirectory: (key, directory) => key === directory,
      noteReleased: vi.fn(),
    };
    const harness = await createHarness({ tracker });

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(tracker.noteReleased).not.toHaveBeenCalled();
  });

  it('does not dispose a candidate whose own entry is in flight while a sibling alias entry is clear', async () => {
    const clock = createClock();
    let linkResolves = true;
    const realpath = async (value) => {
      if (value !== '/link') return value;
      if (!linkResolves) throw new Error('ENOENT');
      return '/real';
    };
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath });
    const probeStarted = createDeferred();
    const probeHeld = createDeferred();
    const harness = await createHarness({
      clock,
      tracker,
      upstreamHandlers: {
        '/session/status': async (_req, res, directory) => {
          // Keep the /real alias entry tracked and clear so the sweep skips it
          // instead of disposing it and dropping the /link spelling with it.
          if (directory === '/real') {
            sendJson(res, 200, { ses_alias: { type: 'busy' } });
            return;
          }
          probeStarted.resolve();
          await probeHeld.promise;
          sendJson(res, 200, {});
        },
      },
    });

    // First observation resolves /link to /real, so /link is only a spelling of
    // the /real entry. The clock jump also expires the realpath success cache.
    await observe(harness, '/link');
    clock.advance(IDLE_WINDOW_MS);

    // Resolution now fails, so a second observation keys /link as its own entry
    // while the older /real entry still holds /link as an observed spelling.
    linkResolves = false;
    await observe(harness, '/link');
    clock.advance(IDLE_WINDOW_MS);
    expect(tracker.matchesDirectory('/real', '/link')).toBe(true);

    const sweep = harness.reaper.runSweep();
    await probeStarted.promise;

    // The candidate acquires an in-flight request on its own entry while its
    // probes are in flight; the alias entry stays clear.
    const release = await tracker.observeRequest('/link');
    probeHeld.resolve();
    await sweep;

    expect(disposeCalls(harness)).toEqual([]);
    const entries = tracker.snapshot();
    expect(entries.map((entry) => entry.directory)).toEqual(['/real', '/link']);
    expect(entries.find((entry) => entry.directory === '/link').inflight).toBe(1);
    expect(harness.logs.warn).toEqual([]);
    expect(harness.logs.log).toEqual([]);

    release();
    expect(tracker.snapshot().find((entry) => entry.directory === '/link').inflight).toBe(0);
  });

  it('does not dispose a directory whose activity is stamped while a probe is in flight', async () => {
    const probeStarted = createDeferred();
    const probeHeld = createDeferred();
    const harness = await createHarness({
      upstreamHandlers: {
        '/session/status': async (_req, res) => {
          probeStarted.resolve();
          await probeHeld.promise;
          sendJson(res, 200, {});
        },
      },
    });
    await observeQuiet(harness, '/repo/race');

    const sweep = harness.reaper.runSweep();
    await probeStarted.promise;

    // A queue dispatch or scheduled run stamps activity without touching
    // inflight, so the reaper must re-read the entry before it disposes.
    await harness.tracker.stampActivity('/repo/race');
    const restampedAt = harness.clock.now();
    probeHeld.resolve();
    await sweep;

    expect(disposeCalls(harness)).toEqual([]);
    expect(harness.tracker.snapshot()).toEqual([
      { directory: '/repo/race', lastActivityAt: restampedAt, inflight: 0 },
    ]);
    expect(harness.logs.log).toEqual([]);
    expect(harness.logs.warn).toEqual([]);

    // A fresh stamp is a legitimate reschedule, not a failure: without backoff
    // the next sweep after the idle window releases the directory.
    harness.clock.advance(IDLE_WINDOW_MS);
    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toEqual(['/repo/race']);
    expect(harness.tracker.snapshot()).toEqual([]);
  });

  it('does not dispose when queued work appears while the probes are in flight', async () => {
    let queued = false;
    let queueArrived = false;
    const harness = await createHarness({
      reaper: { hasQueuedWork: () => queued },
      upstreamHandlers: {
        '/question': (_req, res) => {
          if (!queueArrived) {
            queueArrived = true;
            queued = true;
          }
          sendJson(res, 200, []);
        },
      },
    });
    await observeQuiet(harness, '/repo/late-queue');

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.warn).toEqual([]);

    // Queued work is not a probe failure: no backoff, and once the queue is
    // clear the still-quiet directory is released on the next sweep.
    queued = false;
    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toEqual(['/repo/late-queue']);
  });

  it('skips a candidate whose entry is deregistered while the probes are in flight', async () => {
    const probeStarted = createDeferred();
    const probeHeld = createDeferred();
    const harness = await createHarness({
      upstreamHandlers: {
        '/session/status': async (_req, res) => {
          probeStarted.resolve();
          await probeHeld.promise;
          sendJson(res, 200, {});
        },
      },
    });
    await observeQuiet(harness, '/repo/vanished');

    const sweep = harness.reaper.runSweep();
    await probeStarted.promise;

    // `server.instance.disposed` can deregister the entry mid-sweep.
    await harness.tracker.deregister('/repo/vanished');
    probeHeld.resolve();
    await sweep;

    expect(disposeCalls(harness)).toEqual([]);
    expect(harness.tracker.snapshot()).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('shares one in-flight sweep between concurrent runSweep calls', async () => {
    const readSettings = vi.fn(async () => ({ idleInstanceTimeoutMs: IDLE_WINDOW_MS }));
    const harness = await createHarness({ reaper: { readSettings } });
    await observeQuiet(harness, '/repo/one');

    const first = harness.reaper.runSweep();
    const second = harness.reaper.runSweep();

    // The second call joins the first instead of starting a second sequence.
    expect(second).toBe(first);
    expect(readSettings).toHaveBeenCalledTimes(1);
    await Promise.all([first, second]);

    expect(harness.upstream.calls).toEqual([
      { method: 'GET', path: '/session/status', directory: '/repo/one' },
      { method: 'GET', path: '/permission', directory: '/repo/one' },
      { method: 'GET', path: '/question', directory: '/repo/one' },
      { method: 'POST', path: '/instance/dispose', directory: '/repo/one' },
    ]);
    expect(readSettings).toHaveBeenCalledTimes(1);
  });

  it('does not log a release when the entry was already forgotten at release time', async () => {
    const tracker = {
      listQuietDirectories: () => [{ directory: '/repo/gone', lastActivityAt: 0, inflight: 0 }],
      snapshot: () => [{ directory: '/repo/gone', lastActivityAt: 0, inflight: 0 }],
      matchesDirectory: (key, directory) => key === directory,
      noteReleased: vi.fn(async () => false),
    };
    const harness = await createHarness({ tracker });
    harness.clock.advance(IDLE_WINDOW_MS);

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/gone']);
    expect(tracker.noteReleased).toHaveBeenCalledWith('/repo/gone');
    expect(harness.logs.log).toEqual([
      '[instance-reaper] sweep complete: released=1 failed=0 skipped=0',
    ]);
    expect(harness.logs.debug).toEqual([
      '[instance-reaper] /repo/gone disposed but was no longer tracked',
    ]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('fails only the candidate whose probe URL cannot be built', async () => {
    const portRef = { value: 0 };
    let failBuild = true;
    const harness = await createHarness({
      portRef,
      reaper: {
        buildOpenCodeUrl: (path) => {
          if (failBuild) throw new Error('OpenCode port is not available');
          return `http://127.0.0.1:${portRef.value}${path}`;
        },
      },
    });
    await observeQuiet(harness, '/repo/one');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.warn).toEqual([
      `[instance-reaper] probe failed for /repo/one (/session/status url unavailable); retry after ${FAILURE_BACKOFF_MS}ms`,
    ]);

    // Per-candidate backoff, not a sweep-wide abort: the second sweep skips
    // before the URL is built at all, and the retry after backoff releases.
    const callsBeforeRetry = harness.upstream.calls.length;
    await harness.reaper.runSweep();
    expect(harness.upstream.calls).toHaveLength(callsBeforeRetry);

    failBuild = false;
    harness.clock.advance(FAILURE_BACKOFF_MS);
    await harness.reaper.runSweep();
    expect(disposeCalls(harness)).toEqual(['/repo/one']);
  });

  it('fails closed with backoff on malformed probe payloads without affecting other candidates', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        '/session/status': (_req, res, directory) => sendJson(
          res,
          200,
          directory === '/repo/malformed-status' ? [] : {},
        ),
        '/permission': (_req, res, directory) => sendJson(
          res,
          200,
          directory === '/repo/malformed-permission' ? { items: [] } : [],
        ),
        '/question': (_req, res, directory) => sendJson(
          res,
          200,
          directory === '/repo/malformed-question' ? null : [],
        ),
      },
    });
    await observeQuiet(harness, '/repo/malformed-status');
    await observeQuiet(harness, '/repo/malformed-permission');
    await observeQuiet(harness, '/repo/malformed-question');
    await observeQuiet(harness, '/repo/healthy');

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/healthy']);
    expect(harness.tracker.snapshot().map((entry) => entry.directory)).toEqual([
      '/repo/malformed-status',
      '/repo/malformed-permission',
      '/repo/malformed-question',
    ]);
    expect(harness.logs.warn).toEqual([
      `[instance-reaper] probe failed for /repo/malformed-status (/session/status payload unknown); retry after ${FAILURE_BACKOFF_MS}ms`,
      `[instance-reaper] probe failed for /repo/malformed-permission (/permission payload unknown); retry after ${FAILURE_BACKOFF_MS}ms`,
      `[instance-reaper] probe failed for /repo/malformed-question (/question payload unknown); retry after ${FAILURE_BACKOFF_MS}ms`,
    ]);
    expect(harness.logs.log).toEqual([
      `[instance-reaper] released /repo/healthy idleMs=${IDLE_WINDOW_MS}`,
      '[instance-reaper] sweep complete: released=1 failed=3 skipped=0',
    ]);

    // Backoff holds: an immediate second sweep probes none of the failures.
    const callsAfterFirstSweep = harness.upstream.calls.length;
    await harness.reaper.runSweep();
    expect(harness.upstream.calls).toHaveLength(callsAfterFirstSweep);
  });

  it('fails closed with backoff when /permission returns 404', async () => {
    const harness = await createHarness({
      upstreamHandlers: {
        '/permission': (_req, res, directory) => sendJson(
          res,
          directory === '/repo/not-found' ? 404 : 200,
          directory === '/repo/not-found' ? { error: 'not found' } : [],
        ),
      },
    });
    await observeQuiet(harness, '/repo/not-found');
    await observeQuiet(harness, '/repo/healthy');

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/healthy']);
    expect(harness.tracker.snapshot().map((entry) => entry.directory)).toEqual(['/repo/not-found']);
    expect(harness.logs.warn).toEqual([
      `[instance-reaper] probe failed for /repo/not-found (/permission status 404); retry after ${FAILURE_BACKOFF_MS}ms`,
    ]);
    expect(harness.logs.log).toEqual([
      `[instance-reaper] released /repo/healthy idleMs=${IDLE_WINDOW_MS}`,
      '[instance-reaper] sweep complete: released=1 failed=1 skipped=0',
    ]);
  });

  it.each([
    ['an external server', { isExternalOpenCode: () => true }],
    ['a restarting server', { isRestartingOpenCode: () => true }],
    ['a shutting-down server', { isShuttingDown: () => true }],
    ['a not-ready managed server', { isManagedOpenCodeReady: () => false }],
  ])('does not sweep or dispose while %s', async (_label, ineligible) => {
    const harness = await createHarness({ reaper: ineligible });
    await observeQuiet(harness, '/repo/one');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.log).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('does nothing when the idle window is 0', async () => {
    const harness = await createHarness({
      reaper: { readSettings: async () => ({ idleInstanceTimeoutMs: 0 }) },
    });
    await observeQuiet(harness, '/repo/one');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
    expect(harness.logs.log).toEqual([]);
  });

  it('lets the environment override enable a window the stored setting disabled', async () => {
    const harness = await createHarness({
      reaper: {
        readSettings: async () => ({ idleInstanceTimeoutMs: 0 }),
        env: { OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS: '60000' },
      },
    });
    await observeQuiet(harness, '/repo/one', 60_000);

    await harness.reaper.runSweep();

    expect(disposeCalls(harness)).toEqual(['/repo/one']);
  });

  it('lets the environment override disable eviction even when the stored setting enables it', async () => {
    const harness = await createHarness({
      reaper: { env: { OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS: '0' } },
    });
    await observeQuiet(harness, '/repo/one');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.tracker.snapshot()).toHaveLength(1);
  });

  it('leaves the stored setting in effect for an unparsable environment override', async () => {
    const harness = await createHarness({
      reaper: {
        readSettings: async () => ({ idleInstanceTimeoutMs: 0 }),
        env: { OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS: 'soon' },
      },
    });
    await observeQuiet(harness, '/repo/one');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
  });

  it('logs nothing when a sweep finds no candidate', async () => {
    const harness = await createHarness();
    await observe(harness, '/repo/recent');

    await harness.reaper.runSweep();

    expect(harness.upstream.calls).toEqual([]);
    expect(harness.logs.log).toEqual([]);
    expect(harness.logs.warn).toEqual([]);
  });

  it('logs no credentials', async () => {
    const harness = await createHarness();
    await observeQuiet(harness, '/repo/quiet');

    await harness.reaper.runSweep();

    const lines = [...harness.logs.log, ...harness.logs.warn].join('\n');
    expect(lines).not.toContain('Authorization');
    expect(lines).not.toContain('Basic ');
  });

  it('sweeps on the configured interval after start and clears the timer on stop', async () => {
    const readSettings = vi.fn(async () => ({ idleInstanceTimeoutMs: 0 }));
    const harness = await createHarness({ reaper: { readSettings, sweepIntervalMs: 60_000 } });

    vi.useFakeTimers();
    harness.reaper.start();
    harness.reaper.start();
    expect(readSettings).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(readSettings).toHaveBeenCalledTimes(1);

    harness.reaper.stop();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(readSettings).toHaveBeenCalledTimes(1);
  });

  it('is stopped by the graceful shutdown runtime before OpenCode teardown', async () => {
    const readSettings = vi.fn(async () => ({ idleInstanceTimeoutMs: 0 }));
    const harness = await createHarness({ reaper: { readSettings, sweepIntervalMs: 60_000, isShuttingDown: () => false } });

    vi.useFakeTimers();
    harness.reaper.start();

    const shutdownRuntime = createGracefulShutdownRuntime({
      process: { exit: vi.fn() },
      shutdownTimeoutMs: 1000,
      getExitOnShutdown: () => false,
      // The reaper's own guard stays false: only stop() can prevent the next sweep.
      getIsShuttingDown: () => false,
      setIsShuttingDown: vi.fn(),
      syncToHmrState: vi.fn(),
      openCodeWatcherRuntime: { stop: vi.fn() },
      sessionRuntime: { dispose: vi.fn() },
      idleInstanceReaper: harness.reaper,
      getHealthCheckInterval: () => null,
      clearHealthCheckInterval: vi.fn(),
      getTerminalRuntime: () => null,
      setTerminalRuntime: vi.fn(),
      getMessageStreamRuntime: () => null,
      setMessageStreamRuntime: vi.fn(),
      shouldSkipOpenCodeStop: () => true,
      getOpenCodePort: () => null,
      getOpenCodeProcess: () => null,
      setOpenCodeProcess: vi.fn(),
      killProcessOnPort: vi.fn(),
      waitForPortRelease: vi.fn(async () => true),
      getServer: () => null,
      getUiAuthController: () => null,
      setUiAuthController: vi.fn(),
      getActiveTunnelController: () => null,
      setActiveTunnelController: vi.fn(),
      tunnelAuthController: { clearActiveTunnel: vi.fn() },
    });

    await shutdownRuntime.gracefulShutdown({ exitProcess: false });
    await vi.advanceTimersByTimeAsync(180_000);

    expect(readSettings).not.toHaveBeenCalled();
  });
});
