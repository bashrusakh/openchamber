import { normalizeIdleInstanceTimeoutMs } from './settings-normalization-runtime.js';

/**
 * Idle managed-instance reaper for issue #3768.
 *
 * After a managed OpenCode server is ready, the reaper periodically releases
 * directory instances whose observed activity is older than the configured
 * idle window. It owns invariants I2 through I6 of
 * `plans/issue-3768-idle-instance-eviction/plan.md`:
 *
 * - I2: every candidate is re-verified at decision time — no in-flight proxied
 *   request, `/session/status` reports no busy/retry session, `/permission` and
 *   `/question` are empty, and the injected queue predicate reports no queued
 *   or in-flight send. The request-side checks run again immediately before
 *   the dispose request, because the probes await and a queue dispatch or
 *   scheduled run can stamp activity while they are in flight.
 * - I3: sweeps never overlap and a released directory leaves the tracker, so a
 *   second dispose needs newly observed activity.
 * - I4: sweeps require a managed, ready, non-external runtime.
 * - I5: restarting and shutting down runtimes are skipped; the reaper only
 *   calls the upstream dispose endpoint and never kills or restarts anything.
 * - I6: any probe that cannot establish "no work" (non-2xx, malformed payload,
 *   transport failure) skips that candidate and backs it off.
 *
 * Candidates come only from the caller's activity tracker, so a directory
 * nobody observed is never disposed (I1). Probes are direct fetches through the
 * caller's URL/auth helpers, so they bypass the proxy and are never stamped as
 * activity (I7).
 */
const SWEEP_INTERVAL_MS = 60_000;
const MAX_CANDIDATES_PER_SWEEP = 10;
const FAILURE_BACKOFF_MS = 5 * 60 * 1000;
const PROBE_TIMEOUT_MS = 5_000;
const DISPOSE_TIMEOUT_MS = 15_000;

/**
 * `OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS` wins over the stored setting whenever
 * it parses to a finite non-negative number (`0` disables). Unset, blank, or
 * unparsable values return `null` so the caller falls back to the setting.
 */
const readEnvIdleTimeoutOverride = (env) => {
  const raw = env?.OPENCHAMBER_IDLE_INSTANCE_TIMEOUT_MS;
  const text = raw === undefined || raw === null ? '' : String(raw).trim();
  if (text === '') {
    return null;
  }
  const parsed = Number(text);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
};

const classifyTransportError = (error) => {
  const names = [error?.name, error?.cause?.name].map((value) => String(value ?? ''));
  if (names.includes('TimeoutError') || names.includes('AbortError')) return 'timeout';
  if (names.includes('TypeError')) return 'network';
  return 'error';
};

/**
 * JSON object contract for a decoded response body: a plain record, not null,
 * an array, or a primitive. The `/session/status` body is decoded through this
 * boundary before any domain branch reads it, so `null` and `[]` cannot fall
 * through to a false "idle" answer.
 */
const isPlainJsonObject = (value) => (
  value !== null
  && value !== undefined
  && Object.getPrototypeOf(value) === Object.prototype
);

/**
 * `/session/status` omits idle sessions, so an empty map is the authoritative
 * "nothing running" answer. `busy`/`retry` entries are work; anything else
 * present is a shape this reaper does not understand and fails closed.
 */
const classifySessionStatusPayload = (payload) => {
  if (!isPlainJsonObject(payload)) {
    return 'unknown';
  }
  for (const status of Object.values(payload)) {
    const type = status?.type;
    if (type === 'idle') continue;
    if (type === 'busy' || type === 'retry') return 'work';
    return 'unknown';
  }
  return 'idle';
};

const classifyPendingListPayload = (payload) => {
  if (!Array.isArray(payload)) return 'unknown';
  return payload.length > 0 ? 'work' : 'idle';
};

const cancelResponseBody = async (response) => {
  try {
    await response?.body?.cancel?.();
  } catch {
  }
};

export const createIdleInstanceReaper = (dependencies) => {
  const {
    tracker,
    readSettings,
    hasQueuedWork,
    getOpenCodePort,
    isManagedOpenCodeReady,
    isExternalOpenCode,
    isRestartingOpenCode,
    isShuttingDown,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    // Defaults to the live environment, like `logger` defaults to the console;
    // index.js passes `process.env` explicitly and tests inject a stub.
    env = process.env,
    fetchImpl = fetch,
    now = Date.now,
    logger = console,
    sweepIntervalMs = SWEEP_INTERVAL_MS,
    disposeTimeoutMs = DISPOSE_TIMEOUT_MS,
  } = dependencies;

  // Directories that failed a probe or dispose stay quiet in the tracker, so
  // without this map every sweep would retry them. Entries are pruned when the
  // tracker forgets the directory, keeping the map bounded by tracked work.
  const backoffUntil = new Map();
  let sweepTimer = null;
  let sweepPromise = null;

  const log = (message) => logger.log(`[instance-reaper] ${message}`);
  const warn = (message) => logger.warn(`[instance-reaper] ${message}`);
  const debug = (message) => logger.debug?.(`[instance-reaper] ${message}`);

  const isRuntimeEligible = () => (
    !isShuttingDown()
    && !isRestartingOpenCode()
    && !isExternalOpenCode()
    && isManagedOpenCodeReady()
  );

  const resolveIdleTimeoutMs = async () => {
    const override = readEnvIdleTimeoutOverride(env);
    if (override !== null) {
      return override;
    }

    let settings;
    try {
      settings = await readSettings();
    } catch (error) {
      // Without the configured window the sweep cannot know whether eviction
      // is enabled; skipping is safer than falling back to the default.
      warn(`skipping sweep: settings read failed (${error?.message ?? error})`);
      return null;
    }
    if (!settings) {
      warn('skipping sweep: settings unavailable');
      return null;
    }
    return normalizeIdleInstanceTimeoutMs(settings.idleInstanceTimeoutMs);
  };

  /**
   * One directory-scoped JSON probe. `failed` means the answer could not
   * establish "no work" and the candidate must be skipped with backoff.
   */
  const probeJson = async (path, directory, { allowNotFound = false } = {}) => {
    // A managed restart can clear the captured port between the sweep's port
    // check and this call, and `buildOpenCodeUrl` throws when it has no port.
    // Keeping the build inside the guarded path classifies that as this
    // candidate's failed probe instead of aborting the whole sweep.
    let url;
    try {
      url = `${buildOpenCodeUrl(path, '')}?directory=${encodeURIComponent(directory)}`;
    } catch {
      return { kind: 'failed', detail: `${path} url unavailable` };
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
    } catch (error) {
      return { kind: 'failed', detail: `${path} transport ${classifyTransportError(error)}` };
    }

    if (allowNotFound && response.status === 404) {
      await cancelResponseBody(response);
      return { kind: 'unsupported' };
    }
    if (!response.ok) {
      await cancelResponseBody(response);
      return { kind: 'failed', detail: `${path} status ${response.status}` };
    }

    const payload = await response.json().catch(() => null);
    return { kind: 'ok', payload };
  };

  const evaluateCandidate = async (directory) => {
    // The queue is local bookkeeping, so a known dispatch never needs network
    // probes. A throwing predicate is unknown state and fails closed.
    try {
      if (hasQueuedWork(directory)) {
        return { kind: 'work', disposition: 'queued' };
      }
    } catch (error) {
      return { kind: 'failed', detail: `queue check transport ${classifyTransportError(error)}` };
    }

    const status = await probeJson('/session/status', directory);
    if (status.kind === 'failed') return status;
    const statusClass = classifySessionStatusPayload(status.payload);
    if (statusClass === 'work') return { kind: 'work', disposition: 'session-status' };
    if (statusClass !== 'idle') return { kind: 'failed', detail: '/session/status payload unknown' };

    const permissions = await probeJson('/permission', directory);
    if (permissions.kind === 'failed') return permissions;
    const permissionClass = classifyPendingListPayload(permissions.payload);
    if (permissionClass === 'work') return { kind: 'work', disposition: 'permission' };
    if (permissionClass !== 'idle') return { kind: 'failed', detail: '/permission payload unknown' };

    const questions = await probeJson('/question', directory, { allowNotFound: true });
    if (questions.kind === 'failed') return questions;
    if (questions.kind === 'ok') {
      const questionClass = classifyPendingListPayload(questions.payload);
      if (questionClass === 'work') return { kind: 'work', disposition: 'question' };
      if (questionClass !== 'idle') return { kind: 'failed', detail: '/question payload unknown' };
    }

    return { kind: 'idle' };
  };

  /**
   * The tracker's live entry for `directory`. An exact key wins: the candidate
   * always arrives as a key from `listQuietDirectories`, and `matchesDirectory`
   * also accepts spellings observed for a sibling entry, so a plain scan could
   * read that sibling's in-flight/activity state instead of the candidate's.
   * The spelling scan stays as the fallback for a candidate whose entry was
   * forgotten and re-created under a new key while it was listed. Returns null
   * when the directory is no longer tracked.
   */
  const findLiveEntry = (directory) => {
    const entries = tracker.snapshot();
    const exact = entries.find((entry) => entry.directory === directory);
    if (exact) {
      return exact;
    }
    return entries.find((entry) => tracker.matchesDirectory(entry.directory, directory)) ?? null;
  };

  /**
   * Decision-time work boundary, read fresh from the tracker. A candidate must
   * not be disposed when it left the tracker, holds an in-flight request, was
   * stamped inside the current idle window, or has queued work. The freshness
   * read is the one the proxy cannot provide: a queue dispatch or scheduled run
   * stamps `lastActivityAt` without touching `inflight`, so a stamp that lands
   * while a probe is in flight is only visible here. Fresh activity or queued
   * work is a legitimate reschedule, not a failure, and applies no backoff; a
   * throwing queue predicate leaves the work state unknown, so it is returned
   * as a failure and the caller fails closed.
   */
  const inspectCandidate = (directory, idleMs) => {
    const current = findLiveEntry(directory);
    if (!current) return { kind: 'untracked' };
    if (current.inflight > 0) return { kind: 'inflight' };
    if (now() - current.lastActivityAt < idleMs) return { kind: 'active' };

    try {
      if (hasQueuedWork(directory)) return { kind: 'queued' };
    } catch (error) {
      return { kind: 'failed', detail: `queue check transport ${classifyTransportError(error)}` };
    }
    return { kind: 'clear' };
  };

  const requestDispose = async (directory) => {
    let url;
    try {
      url = `${buildOpenCodeUrl('/instance/dispose', '')}?directory=${encodeURIComponent(directory)}`;
    } catch {
      return { ok: false, detail: 'url unavailable' };
    }

    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Accept: 'application/json', ...getOpenCodeAuthHeaders() },
        signal: AbortSignal.timeout(disposeTimeoutMs),
      });
    } catch (error) {
      return { ok: false, detail: `transport ${classifyTransportError(error)}` };
    }

    await cancelResponseBody(response);
    if (!response.ok) {
      return { ok: false, detail: `status ${response.status}` };
    }
    return { ok: true };
  };

  const pruneBackoff = () => {
    if (backoffUntil.size === 0) return;
    const tracked = new Set(tracker.snapshot().map((entry) => entry.directory));
    for (const directory of Array.from(backoffUntil.keys())) {
      if (!tracked.has(directory)) {
        backoffUntil.delete(directory);
      }
    }
  };

  const sweepOnce = async () => {
    if (!isRuntimeEligible()) return;

    const idleMs = await resolveIdleTimeoutMs();
    if (idleMs === null || idleMs === 0) return;

    // Capture the port once and never release against a different instance: a
    // managed restart can move OpenCode to a new port mid-sweep.
    const sweepPort = getOpenCodePort();
    if (!Number.isFinite(sweepPort) || sweepPort <= 0) return;
    const isSweepPortStable = () => getOpenCodePort() === sweepPort;

    pruneBackoff();

    const quiet = tracker.listQuietDirectories(idleMs);
    if (!Array.isArray(quiet) || quiet.length === 0) return;

    let released = 0;
    let failed = 0;
    let skipped = 0;

    const failCandidate = (directory, detail) => {
      failed += 1;
      backoffUntil.set(directory, now() + FAILURE_BACKOFF_MS);
      warn(`probe failed for ${directory} (${detail}); retry after ${FAILURE_BACKOFF_MS}ms`);
    };

    for (const candidate of quiet.slice(0, MAX_CANDIDATES_PER_SWEEP)) {
      const directory = candidate?.directory;
      if (!directory) {
        skipped += 1;
        continue;
      }

      if (!isRuntimeEligible() || !isSweepPortStable()) break;

      const retryAt = backoffUntil.get(directory);
      if (retryAt !== undefined && retryAt > now()) {
        skipped += 1;
        continue;
      }

      // Re-read before probing: a request, queued dispatch, or scheduled run
      // may have started between the quiet listing and this candidate.
      const beforeProbe = inspectCandidate(directory, idleMs);
      if (beforeProbe.kind === 'failed') {
        failCandidate(directory, beforeProbe.detail);
        continue;
      }
      if (beforeProbe.kind !== 'clear') {
        skipped += 1;
        continue;
      }

      const decision = await evaluateCandidate(directory);
      if (decision.kind === 'work') {
        skipped += 1;
        continue;
      }
      if (decision.kind === 'failed') {
        failCandidate(directory, decision.detail);
        continue;
      }

      if (!isRuntimeEligible() || !isSweepPortStable()) break;

      // The probes awaited, so activity can have arrived after the candidate
      // listing. Queue dispatches and scheduled runs stamp `lastActivityAt`
      // without touching `inflight`, so only this fresh read can catch them.
      const beforeDispose = inspectCandidate(directory, idleMs);
      if (beforeDispose.kind === 'failed') {
        failCandidate(directory, beforeDispose.detail);
        continue;
      }
      if (beforeDispose.kind !== 'clear') {
        skipped += 1;
        continue;
      }

      const outcome = await requestDispose(directory);
      if (outcome.ok) {
        released += 1;
        backoffUntil.delete(directory);
        const forgotten = await tracker.noteReleased(directory);
        if (forgotten) {
          log(`released ${directory} idleMs=${idleMs}`);
        } else {
          // Another path (`server.instance.disposed`, say) already deregistered
          // the entry while the dispose was in flight.
          debug(`${directory} disposed but was no longer tracked`);
        }
      } else {
        failed += 1;
        backoffUntil.set(directory, now() + FAILURE_BACKOFF_MS);
        warn(`dispose failed for ${directory} (${outcome.detail}); retry after ${FAILURE_BACKOFF_MS}ms`);
      }
    }

    // Only sweeps that released or failed something are worth a summary; a
    // quiet sweep must not produce per-minute noise.
    if (released > 0 || failed > 0) {
      log(`sweep complete: released=${released} failed=${failed} skipped=${skipped}`);
    }
  };

  const runSweep = () => {
    if (sweepPromise) {
      return sweepPromise;
    }
    sweepPromise = sweepOnce()
      .catch((error) => {
        warn(`sweep failed: ${error?.message ?? error}`);
      })
      .finally(() => {
        sweepPromise = null;
      });
    return sweepPromise;
  };

  const start = () => {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      void runSweep();
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  };

  const stop = () => {
    if (!sweepTimer) return;
    clearInterval(sweepTimer);
    sweepTimer = null;
  };

  return {
    start,
    stop,
    runSweep,
  };
};
