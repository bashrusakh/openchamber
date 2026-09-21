import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { CONSULT_GC_THRESHOLD_MS, sweepStaleAdvisorForks, type ConsultGcDeps } from './gc';

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;

const advisorFork = (id: string, runId: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project-1',
  directory: '/work',
  title: id,
  version: '1.18.31',
  time: { created: updated, updated },
  metadata: {
    openchamber: {
      kind: 'consult-advisor',
      originalSessionID: 'parent',
      consultRunID: runId,
      advisorIndex: 0,
    },
  },
});

const normalSession = (id: string, updated: number): Session => ({
  id,
  slug: id,
  projectID: 'project-1',
  directory: '/work',
  title: id,
  version: '1.18.31',
  time: { created: updated, updated },
});

type GcState = {
  sessions: Session[];
  activeRuns: Set<string>;
  deleted: Array<{ id: string; directory: string; runtimeKey: string }>;
  failures: Set<string>;
  released: string[];
  runtimeKey: string;
  listeners: Array<() => void>;
  onDelete?: (sessionId: string) => void;
};

const createDeps = (overrides: Partial<ConsultGcDeps> = {}) => {
  const state: GcState = {
    sessions: [],
    activeRuns: new Set(),
    deleted: [],
    failures: new Set(),
    released: [],
    runtimeKey: 'runtime-1',
    listeners: [],
  };

  const deps: ConsultGcDeps = {
    listSessions: () => state.sessions,
    deleteSession: async (sessionId, directory, runtimeKey) => {
      state.onDelete?.(sessionId);
      if (state.failures.has(sessionId)) throw new Error(`delete failed: ${sessionId}`);
      state.deleted.push({ id: sessionId, directory, runtimeKey });
      return true;
    },
    isRunActive: (runId) => state.activeRuns.has(runId),
    releasePendingHide: (sessionId) => state.released.push(sessionId),
    runtimeKey: () => state.runtimeKey,
    subscribeRuntimeChange: (listener) => {
      state.listeners.push(listener);
      return () => {
        state.listeners = state.listeners.filter((entry) => entry !== listener);
      };
    },
    now: () => NOW,
    ...overrides,
  };

  return { deps, state };
};

describe('stale advisor fork GC', () => {
  test('deletes forks older than the threshold and releases their pending-hide entries', async () => {
    const { deps, state } = createDeps();
    state.sessions = [
      advisorFork('stale', 'run-1', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
      advisorFork('fresh', 'run-2', NOW - MINUTE),
      normalSession('normal', NOW - 10 * MINUTE),
    ];

    const result = await sweepStaleAdvisorForks(deps);

    expect(CONSULT_GC_THRESHOLD_MS).toBe(60 * MINUTE);
    expect(result).toEqual({ deletedIds: ['stale'], failedIds: [] });
    expect(state.deleted).toEqual([{ id: 'stale', directory: '/work', runtimeKey: 'runtime-1' }]);
    expect(state.released).toEqual(['stale']);
  });

  test('never deletes a fork whose run is still active', async () => {
    const { deps, state } = createDeps();
    state.activeRuns.add('run-live');
    state.sessions = [
      advisorFork('live-fork', 'run-live', NOW - 10 * CONSULT_GC_THRESHOLD_MS),
      advisorFork('orphan', 'run-gone', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
    ];

    const result = await sweepStaleAdvisorForks(deps);

    expect(result).toEqual({ deletedIds: ['orphan'], failedIds: [] });
  });

  test('ignores sessions without a valid advisor marker', async () => {
    const { deps, state } = createDeps();
    const malformed = {
      ...advisorFork('malformed', 'run-1', NOW - 2 * CONSULT_GC_THRESHOLD_MS),
      metadata: { openchamber: { kind: 'consult-advisor', originalSessionID: 'parent' } },
    };
    const btwFork = {
      ...normalSession('btw-fork', NOW - 2 * CONSULT_GC_THRESHOLD_MS),
      metadata: { openchamber: { kind: 'btw', originalSessionID: 'parent' } },
    };
    state.sessions = [malformed, btwFork];

    const result = await sweepStaleAdvisorForks(deps);

    expect(result).toEqual({ deletedIds: [], failedIds: [] });
    expect(state.deleted).toEqual([]);
  });

  test('collects a partial marker carrying the kind and the run id without the parent id', async () => {
    // The notification server suppresses on the same two fields, so the GC
    // must collect exactly the sessions that are hidden/silenced there.
    const { deps, state } = createDeps();
    const partial = {
      ...advisorFork('partial', 'run-dead', NOW - 2 * CONSULT_GC_THRESHOLD_MS),
      metadata: { openchamber: { kind: 'consult-advisor', consultRunID: 'run-dead' } },
    };
    state.sessions = [partial];

    const result = await sweepStaleAdvisorForks(deps);

    expect(result.deletedIds).toEqual(['partial']);
    expect(state.deleted).toEqual([{ id: 'partial', directory: '/work', runtimeKey: 'runtime-1' }]);
  });

  test('stops the sweep when the runtime changes and keeps the partial result', async () => {
    const { deps, state } = createDeps();
    state.sessions = [
      advisorFork('stale-1', 'run-1', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
      advisorFork('stale-2', 'run-2', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
    ];
    state.onDelete = () => {
      for (const listener of [...state.listeners]) listener();
    };

    const result = await sweepStaleAdvisorForks(deps);

    expect(result.deletedIds).toEqual(['stale-1']);
    expect(result.failedIds).toEqual([]);
    expect(result.skippedReason).toBe('runtime-changed');
    expect(state.deleted.map((entry) => entry.id)).toEqual(['stale-1']);
  });

  test('one failed delete does not block the other candidates', async () => {
    const { deps, state } = createDeps();
    state.failures.add('bad');
    state.sessions = [
      advisorFork('bad', 'run-1', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
      advisorFork('good', 'run-2', NOW - CONSULT_GC_THRESHOLD_MS - MINUTE),
    ];

    const result = await sweepStaleAdvisorForks(deps);

    expect(result.deletedIds).toEqual(['good']);
    expect(result.failedIds).toEqual(['bad']);
    expect(state.released).toEqual(['good']);
  });

  test('uses the injected threshold', async () => {
    const { deps, state } = createDeps({ thresholdMs: MINUTE });
    state.sessions = [advisorFork('older', 'run-1', NOW - 2 * MINUTE), advisorFork('younger', 'run-2', NOW - MINUTE / 2)];

    const result = await sweepStaleAdvisorForks(deps);

    expect(result.deletedIds).toEqual(['older']);
  });
});
