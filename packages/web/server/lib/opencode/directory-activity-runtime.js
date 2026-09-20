import { createRealpathCache } from '../path-realpath-cache.js';

/**
 * Per-directory activity and in-flight request bookkeeping for managed-instance
 * idle eviction (issue #3768).
 *
 * The proxy reports every directory-scoped `/api/*` request through
 * `observeRequest()`, which stamps activity and resolves to a release function
 * the caller invokes exactly once when the response settles. OpenChamber-owned
 * upstream work that never passes the proxy (startup warmup, a queue dispatch,
 * a scheduled run) stamps through `stampActivity()` instead. The idle-instance
 * reaper reads `listQuietDirectories()` and calls `noteReleased()` after a
 * successful upstream dispose. `deregister()` mirrors an upstream
 * `server.instance.disposed` event.
 *
 * Directory keys reuse the proxy's realpath handling and follow win32 casing,
 * so one project maps to one entry. `matchesDirectory()` lets a caller holding
 * a directory in another form (the client-supplied queue directory, say)
 * compare synchronously against those keys without re-resolving realpath.
 * Clock and realpath are injected so tests are deterministic. Tracking is
 * observation-only: this module never calls upstream, and a directory nobody
 * observed is never a candidate (I1).
 */
export const createDirectoryActivityRuntime = ({
  realpath,
  now = () => Date.now(),
  isWin32 = process.platform === 'win32',
} = {}) => {
  const realpathCache = createRealpathCache({ realpath, fallbackOnError: true, now });
  const entries = new Map();
  // Key -> raw spellings that have resolved to it. A spelling outlives the
  // request that produced it only until the directory leaves the tracker, so
  // the alias set stays bounded by the entries themselves.
  const observedSpellings = new Map();

  const fold = (value) => (isWin32 ? value.toLowerCase() : value);

  const resolveKey = async (directory) => {
    if (!directory) {
      return '';
    }

    // Resolve the raw value, the same way the proxy query canonicalizer and the
    // worktree gate treat it: trimming would let a trailing-space path collide
    // with a different directory, and the key is later used as the probe target.
    // `createRealpathCache.resolve` returns the input unchanged when realpath is
    // unavailable or fails (fallbackOnError), so the result is always a
    // non-empty string here.
    const resolved = await realpathCache.resolve(directory);
    return fold(resolved);
  };

  const rememberSpelling = (key, directory) => {
    if (!directory) {
      return;
    }
    let spellings = observedSpellings.get(key);
    if (!spellings) {
      spellings = new Set();
      observedSpellings.set(key, spellings);
    }
    spellings.add(fold(directory));
  };

  // Observation paths also record the raw spelling, so a later sync comparison
  // can recognize the same directory arriving in the form a client uses.
  const resolveObservedKey = async (directory) => {
    const key = await resolveKey(directory);
    if (key) {
      rememberSpelling(key, directory);
    }
    return key;
  };

  // Successful release and upstream `server.instance.disposed` are the same
  // state transition: the directory becomes untracked, so a second dispose
  // needs newly observed activity (I3).
  const forget = async (directory) => {
    const key = await resolveKey(directory);
    if (!key) {
      return false;
    }
    observedSpellings.delete(key);
    return entries.delete(key);
  };

  const observeRequest = async (directory) => {
    const key = await resolveObservedKey(directory);
    if (!key) {
      return () => {};
    }

    let entry = entries.get(key);
    if (!entry) {
      entry = { directory: key, lastActivityAt: now(), inflight: 0 };
      entries.set(key, entry);
    }

    const observed = entry;
    observed.lastActivityAt = now();
    observed.inflight += 1;

    let released = false;
    return () => {
      if (released) {
        return;
      }
      released = true;
      // The closure holds the entry object it incremented, so a late release
      // after the entry was forgotten and re-created cannot decrement the new
      // entry's in-flight count.
      observed.inflight -= 1;
    };
  };

  /**
   * Stamps activity for OpenChamber-owned upstream work that bypasses the
   * proxy observer, so the directory's idle window restarts. In-flight stays
   * untouched: there is no paired response for this module to release, and a
   * single stamp must not strand a counter. An unobserved, non-empty
   * directory becomes tracked with zero in-flight work.
   */
  const stampActivity = async (directory) => {
    const key = await resolveObservedKey(directory);
    if (!key) {
      return false;
    }

    const entry = entries.get(key);
    if (entry) {
      entry.lastActivityAt = now();
    } else {
      entries.set(key, { directory: key, lastActivityAt: now(), inflight: 0 });
    }
    return true;
  };

  const snapshot = () => Array.from(entries.values(), (entry) => ({ ...entry }));

  /**
   * Whether `directory` is a form of the tracked entry `key`. Both values are
   * directory strings (from a tracker snapshot and from parsed client input).
   * An exact key matches while the entry is tracked; otherwise the raw
   * spelling must have been observed for that key, which is what keeps a
   * symlinked queue directory from slipping past a key comparison.
   * Synchronous by design: the reaper's queue predicate runs at decision time
   * and must not re-enter realpath.
   */
  const matchesDirectory = (key, directory) => {
    if (!key || !directory) {
      return false;
    }
    const raw = fold(directory);
    if (raw === key) {
      return entries.has(key);
    }
    return observedSpellings.get(key)?.has(raw) === true;
  };

  // Oldest first, so a sweep that caps its batch looks at the directories that
  // have been quiet the longest before the ones that just crossed the window.
  const listQuietDirectories = (idleMs) => {
    if (!Number.isFinite(idleMs) || idleMs < 0) {
      return [];
    }

    const currentTime = now();
    return snapshot()
      .filter((entry) => entry.inflight === 0 && currentTime - entry.lastActivityAt >= idleMs)
      .sort((left, right) => left.lastActivityAt - right.lastActivityAt);
  };

  return {
    observeRequest,
    stampActivity,
    matchesDirectory,
    noteReleased: forget,
    deregister: forget,
    snapshot,
    listQuietDirectories,
  };
};
