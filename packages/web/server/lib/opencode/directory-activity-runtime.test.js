import { describe, expect, it } from 'vitest';

import { createDirectoryActivityRuntime } from './directory-activity-runtime.js';

const createClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const identityRealpath = async (value) => value;

describe('createDirectoryActivityRuntime', () => {
  it('stamps activity and pairs a release exactly once', async () => {
    const clock = createClock();
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });

    const release = await tracker.observeRequest('/repo/one');
    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: clock.now(), inflight: 1 },
    ]);

    release();
    release();
    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: clock.now(), inflight: 0 },
    ]);
  });

  it('refreshes last activity and counts concurrent requests for one directory', async () => {
    const clock = createClock();
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });

    const first = await tracker.observeRequest('/repo/one');
    clock.advance(5_000);
    const second = await tracker.observeRequest('/repo/one');

    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: clock.now(), inflight: 2 },
    ]);

    second();
    first();
    expect(tracker.snapshot()[0].inflight).toBe(0);
  });

  it('dedupes symlink and real paths through the injected realpath', async () => {
    const realpath = async (value) => (value === '/link/project' ? '/real/project' : value);
    const tracker = createDirectoryActivityRuntime({ realpath });

    const releaseLink = await tracker.observeRequest('/link/project');
    const releaseReal = await tracker.observeRequest('/real/project');

    expect(tracker.snapshot()).toEqual([
      { directory: '/real/project', lastActivityAt: expect.any(Number), inflight: 2 },
    ]);

    releaseLink();
    releaseReal();
    expect(tracker.snapshot()[0].inflight).toBe(0);
  });

  it('folds case into one key on win32 and keeps case distinct elsewhere', async () => {
    const windowsTracker = createDirectoryActivityRuntime({
      realpath: identityRealpath,
      isWin32: true,
    });
    await windowsTracker.observeRequest('C:\\Repo\\App');
    await windowsTracker.observeRequest('c:\\repo\\app');
    expect(windowsTracker.snapshot().map((entry) => entry.directory)).toEqual(['c:\\repo\\app']);

    const posixTracker = createDirectoryActivityRuntime({
      realpath: identityRealpath,
      isWin32: false,
    });
    await posixTracker.observeRequest('/repo/App');
    await posixTracker.observeRequest('/repo/app');
    expect(posixTracker.snapshot()).toHaveLength(2);
  });

  it('falls back to the raw directory when realpath fails', async () => {
    const tracker = createDirectoryActivityRuntime({
      realpath: async () => {
        throw new Error('missing');
      },
    });

    const release = await tracker.observeRequest('/gone/dir');
    expect(tracker.snapshot()).toEqual([
      { directory: '/gone/dir', lastActivityAt: expect.any(Number), inflight: 1 },
    ]);
    release();
  });

  it('ignores missing and empty directories', async () => {
    const tracker = createDirectoryActivityRuntime({ realpath: identityRealpath });

    const releaseMissing = await tracker.observeRequest(undefined);
    const releaseEmpty = await tracker.observeRequest('');

    expect(tracker.snapshot()).toEqual([]);
    expect(releaseMissing).toBeTypeOf('function');
    expect(() => {
      releaseMissing();
      releaseEmpty();
    }).not.toThrow();
  });

  it('does not let a stale release decrement a re-registered entry', async () => {
    const tracker = createDirectoryActivityRuntime({ realpath: identityRealpath });

    const first = await tracker.observeRequest('/repo/one');
    expect(await tracker.noteReleased('/repo/one')).toBe(true);
    expect(tracker.snapshot()).toEqual([]);

    const second = await tracker.observeRequest('/repo/one');
    first();
    expect(tracker.snapshot()[0].inflight).toBe(1);
    second();
    expect(tracker.snapshot()[0].inflight).toBe(0);
  });

  it('reports whether release and deregistration removed an entry', async () => {
    const realpath = async (value) => (value === '/link/one' ? '/real/one' : value);
    const tracker = createDirectoryActivityRuntime({ realpath });

    await tracker.observeRequest('/link/one');
    expect(await tracker.noteReleased('/real/one')).toBe(true);
    expect(await tracker.noteReleased('/real/one')).toBe(false);
    expect(await tracker.noteReleased('')).toBe(false);

    await tracker.observeRequest('/real/one');
    expect(await tracker.deregister('/link/one')).toBe(true);
    expect(tracker.snapshot()).toEqual([]);
  });

  it('lists quiet directories oldest first and skips in-flight ones', async () => {
    const clock = createClock(0);
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });

    const releaseOld = await tracker.observeRequest('/repo/old');
    clock.advance(10_000);
    const releaseNew = await tracker.observeRequest('/repo/new');
    clock.advance(1_000);
    releaseOld();
    releaseNew();

    expect(tracker.listQuietDirectories(2_000)).toEqual([
      { directory: '/repo/old', lastActivityAt: 0, inflight: 0 },
    ]);

    const releaseBusy = await tracker.observeRequest('/repo/busy');
    expect(tracker.listQuietDirectories(2_000).map((entry) => entry.directory)).toEqual(['/repo/old']);
    releaseBusy();
    expect(tracker.listQuietDirectories(0).map((entry) => entry.directory))
      .toEqual(['/repo/old', '/repo/new', '/repo/busy']);
  });

  it('returns no quiet candidates for a missing or invalid idle window', async () => {
    const clock = createClock(0);
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });
    await tracker.observeRequest('/repo/one');
    clock.advance(60_000);

    expect(tracker.listQuietDirectories(Number.NaN)).toEqual([]);
    expect(tracker.listQuietDirectories(-1)).toEqual([]);
    expect(tracker.listQuietDirectories(undefined)).toEqual([]);
  });

  it('stamps activity for unproxied work without touching in-flight counts', async () => {
    const clock = createClock();
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });

    const release = await tracker.observeRequest('/repo/one');
    expect(await tracker.stampActivity('/repo/one')).toBe(true);
    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: clock.now(), inflight: 1 },
    ]);

    // A directory that only internal work touched becomes tracked with no
    // in-flight request, and a later stamp refreshes its idle window.
    clock.advance(5_000);
    expect(await tracker.stampActivity('/repo/warmed')).toBe(true);
    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: clock.now() - 5_000, inflight: 1 },
      { directory: '/repo/warmed', lastActivityAt: clock.now(), inflight: 0 },
    ]);

    clock.advance(5_000);
    await tracker.stampActivity('/repo/one');
    expect(tracker.snapshot()[0].lastActivityAt).toBe(clock.now());
    expect(tracker.snapshot()[0].inflight).toBe(1);
    release();
  });

  it('ignores missing and empty directories when stamping', async () => {
    const tracker = createDirectoryActivityRuntime({ realpath: identityRealpath });

    expect(await tracker.stampActivity(undefined)).toBe(false);
    expect(await tracker.stampActivity('')).toBe(false);
    expect(tracker.snapshot()).toEqual([]);
  });

  it('matches a tracked key against the spellings it was observed as', async () => {
    const realpath = async (value) => (value === '/link/project' ? '/real/project' : value);
    const tracker = createDirectoryActivityRuntime({ realpath });

    await tracker.observeRequest('/link/project');

    expect(tracker.matchesDirectory('/real/project', '/link/project')).toBe(true);
    expect(tracker.matchesDirectory('/real/project', '/real/project')).toBe(true);
    expect(tracker.matchesDirectory('/real/project', '/elsewhere')).toBe(false);
    expect(tracker.matchesDirectory('/real/project', '')).toBe(false);
    // An untracked key has nothing to match, even against itself.
    expect(tracker.matchesDirectory('/link/project', '/link/project')).toBe(false);
  });

  it('forgets observed spellings when a directory leaves the tracker', async () => {
    const realpath = async (value) => (value === '/link/one' ? '/real/one' : value);
    const tracker = createDirectoryActivityRuntime({ realpath });

    await tracker.observeRequest('/link/one');
    expect(tracker.matchesDirectory('/real/one', '/link/one')).toBe(true);
    await tracker.noteReleased('/real/one');
    expect(tracker.matchesDirectory('/real/one', '/link/one')).toBe(false);
  });

  it('folds case in the spelling match on win32', async () => {
    const tracker = createDirectoryActivityRuntime({
      realpath: identityRealpath,
      isWin32: true,
    });

    await tracker.stampActivity('C:\\Repo\\App');
    expect(tracker.matchesDirectory('c:\\repo\\app', 'C:\\Repo\\App')).toBe(true);
    expect(tracker.matchesDirectory('c:\\repo\\app', 'c:\\REPO\\APP')).toBe(true);
    expect(tracker.matchesDirectory('c:\\repo\\app', 'C:\\Repo\\Other')).toBe(false);
  });

  it('returns snapshot copies that callers cannot mutate', async () => {
    const tracker = createDirectoryActivityRuntime({ realpath: identityRealpath });
    await tracker.observeRequest('/repo/one');

    const snapshot = tracker.snapshot();
    snapshot[0].inflight = 99;
    snapshot[0].directory = '/elsewhere';

    expect(tracker.snapshot()).toEqual([
      { directory: '/repo/one', lastActivityAt: expect.any(Number), inflight: 1 },
    ]);
  });
});
