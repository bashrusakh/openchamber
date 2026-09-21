import { beforeEach, describe, expect, test } from 'bun:test';
import {
  isConsultRunActive,
  selectConsultRun,
  useConsultStore,
  type ConsultAdvisorInput,
  type ConsultRunPhase,
  type ConsultRunStartInput,
} from './useConsultStore';

const advisors: readonly ConsultAdvisorInput[] = [
  { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'plan', variant: 'high' },
  { providerID: 'openai', modelID: 'gpt-5', agent: 'plan', variant: null },
];

const startInput = (overrides: Partial<ConsultRunStartInput> = {}): ConsultRunStartInput => ({
  parentSessionId: 'parent-1',
  runId: 'run-1',
  mode: 'parallel',
  timeoutMs: 120_000,
  advisors,
  ...overrides,
});

const runOf = (parentSessionId: string) =>
  useConsultStore.getState().runsByParentSessionId[parentSessionId];

beforeEach(() => {
  useConsultStore.setState({ runsByParentSessionId: {} });
});

describe('useConsultStore startRun', () => {
  test('starts with no run for any session', () => {
    expect(selectConsultRun(useConsultStore.getState(), 'parent-1')).toBeUndefined();
    expect(isConsultRunActive(undefined)).toBe(false);
  });

  test('creates a waiting-admission run with queued advisors in submitted order', () => {
    useConsultStore.getState().startRun(startInput());

    const run = runOf('parent-1');
    expect(run.runId).toBe('run-1');
    expect(run.phase).toBe('waiting-admission');
    expect(run.mode).toBe('parallel');
    expect(run.timeoutMs).toBe(120_000);
    expect(run.degraded).toBe(false);
    expect(run.error).toBeUndefined();
    expect(run.advisors).toEqual([
      {
        index: 0,
        providerID: 'anthropic',
        modelID: 'claude-sonnet',
        agent: 'plan',
        variant: 'high',
        status: 'queued',
      },
      { index: 1, providerID: 'openai', modelID: 'gpt-5', agent: 'plan', status: 'queued' },
    ]);
    expect(selectConsultRun(useConsultStore.getState(), 'parent-1')).toBe(run);
    expect(isConsultRunActive(run)).toBe(true);
  });

  test('a new run for the same parent replaces the previous record', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ runId: 'run-2', mode: 'sequential' }));

    const run = runOf('parent-1');
    expect(run.runId).toBe('run-2');
    expect(run.mode).toBe('sequential');
    expect(run.phase).toBe('waiting-admission');
  });
});

describe('useConsultStore setPhase', () => {
  test('advances the phase without touching another session', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ parentSessionId: 'parent-2', runId: 'run-2' }));
    const otherBefore = runOf('parent-2');

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'consulting');
    expect(runOf('parent-1').phase).toBe('consulting');
    expect(runOf('parent-2')).toBe(otherBefore);

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'settling');
    useConsultStore.getState().setPhase('parent-1', 'run-1', 'dispatching');
    expect(runOf('parent-1').phase).toBe('dispatching');
    expect(runOf('parent-2')).toBe(otherBefore);
  });

  test('setting the current phase keeps the record reference', () => {
    useConsultStore.getState().startRun(startInput());
    const before = runOf('parent-1');

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'waiting-admission');

    expect(runOf('parent-1')).toBe(before);
  });

  test('idle removes the record', () => {
    useConsultStore.getState().startRun(startInput());

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'idle');

    expect(selectConsultRun(useConsultStore.getState(), 'parent-1')).toBeUndefined();
  });

  test('a superseded runId cannot change the current run', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ runId: 'run-2' }));
    const current = runOf('parent-1');

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'settling');

    expect(runOf('parent-1')).toBe(current);
    expect(runOf('parent-1').phase).toBe('waiting-admission');
  });
});

describe('useConsultStore updateAdvisor', () => {
  test('updates one row and keeps the other rows referentially stable', () => {
    useConsultStore.getState().startRun(startInput());
    const runBefore = runOf('parent-1');
    const firstBefore = runBefore.advisors[0];

    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 1, { status: 'running' });
    expect(runOf('parent-1').advisors[1].status).toBe('running');
    expect(runOf('parent-1').advisors[0]).toBe(firstBefore);
    expect(runOf('parent-1')).not.toBe(runBefore);

    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 1, {
      status: 'ok',
      durationMs: 1400,
    });
    expect(runOf('parent-1').advisors[1]).toEqual({
      index: 1,
      providerID: 'openai',
      modelID: 'gpt-5',
      agent: 'plan',
      status: 'ok',
      durationMs: 1400,
    });
  });

  test('keeps duration and reason when the update omits them', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 0, {
      status: 'timeout',
      durationMs: 5000,
      reason: 'Deadline exceeded',
    });

    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 0, { status: 'failed' });

    expect(runOf('parent-1').advisors[0].durationMs).toBe(5000);
    expect(runOf('parent-1').advisors[0].reason).toBe('Deadline exceeded');
  });

  test('a no-op update and an unknown row keep every reference', () => {
    useConsultStore.getState().startRun(startInput());
    const before = runOf('parent-1');

    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 0, { status: 'queued' });
    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 9, { status: 'running' });

    expect(runOf('parent-1')).toBe(before);
  });

  test('a superseded runId cannot update an advisor', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ runId: 'run-2' }));
    const current = runOf('parent-1');

    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 0, { status: 'ok' });

    expect(runOf('parent-1')).toBe(current);
    expect(runOf('parent-1').advisors[0].status).toBe('queued');
  });
});

describe('useConsultStore finish', () => {
  test('applies the result summary and records per-advisor outcomes', () => {
    useConsultStore.getState().startRun(startInput());

    useConsultStore.getState().finish('parent-1', 'run-1', {
      phase: 'done',
      advisors: [
        { index: 0, status: 'ok', durationMs: 900 },
        { index: 1, status: 'empty', durationMs: 1100, reason: 'No text' },
      ],
    });

    const run = runOf('parent-1');
    expect(run.phase).toBe('done');
    expect(run.degraded).toBe(false);
    expect(run.advisors.map((advisor) => advisor.status)).toEqual(['ok', 'empty']);
    expect(run.advisors[1].reason).toBe('No text');
    expect(isConsultRunActive(run)).toBe(false);
  });

  test('records degraded only on a done run', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().finish('parent-1', 'run-1', {
      phase: 'done',
      degraded: true,
      advisors: [
        { index: 0, status: 'failed' },
        { index: 1, status: 'timeout' },
      ],
    });
    expect(runOf('parent-1').degraded).toBe(true);

    useConsultStore.getState().startRun(startInput({ runId: 'run-2' }));
    useConsultStore.getState().finish('parent-1', 'run-2', { phase: 'cancelled', degraded: true });
    expect(runOf('parent-1').degraded).toBe(false);
  });

  test('records the failure reason and keeps the run until it is dismissed', () => {
    useConsultStore.getState().startRun(startInput());

    useConsultStore.getState().finish('parent-1', 'run-1', {
      phase: 'failed',
      error: 'Runtime changed',
    });

    expect(runOf('parent-1').phase).toBe('failed');
    expect(runOf('parent-1').error).toBe('Runtime changed');
    expect(isConsultRunActive(runOf('parent-1'))).toBe(false);

    useConsultStore.getState().setPhase('parent-1', 'run-1', 'idle');
    expect(runOf('parent-1')).toBeUndefined();
  });

  test('a superseded runId cannot finish the current run', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ runId: 'run-2' }));
    const current = runOf('parent-1');

    useConsultStore.getState().finish('parent-1', 'run-1', { phase: 'cancelled' });

    expect(runOf('parent-1')).toBe(current);
  });
});

describe('useConsultStore cancel', () => {
  test('cancels the run and only the non-terminal advisors', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 0, { status: 'running' });
    useConsultStore.getState().updateAdvisor('parent-1', 'run-1', 1, {
      status: 'ok',
      durationMs: 300,
    });

    useConsultStore.getState().cancel('parent-1', 'run-1');

    const run = runOf('parent-1');
    expect(run.phase).toBe('cancelled');
    expect(run.advisors.map((advisor) => advisor.status)).toEqual(['cancelled', 'ok']);
    expect(run.advisors[1].durationMs).toBe(300);
    expect(isConsultRunActive(run)).toBe(false);
  });

  test('cancelling a finished run keeps its record reference', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().finish('parent-1', 'run-1', { phase: 'done' });
    const finished = runOf('parent-1');

    useConsultStore.getState().cancel('parent-1', 'run-1');

    expect(runOf('parent-1')).toBe(finished);
    expect(runOf('parent-1').phase).toBe('done');
  });

  test('a superseded runId cannot cancel the current run', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ runId: 'run-2' }));
    const current = runOf('parent-1');

    useConsultStore.getState().cancel('parent-1', 'run-1');

    expect(runOf('parent-1')).toBe(current);
    expect(runOf('parent-1').phase).toBe('waiting-admission');
  });
});

describe('useConsultStore selectors and reset', () => {
  test('isConsultRunActive covers every phase', () => {
    useConsultStore.getState().startRun(startInput());
    const run = runOf('parent-1');
    const active: readonly ConsultRunPhase[] = [
      'waiting-admission',
      'consulting',
      'settling',
      'dispatching',
    ];
    const inactive: readonly ConsultRunPhase[] = ['idle', 'done', 'failed', 'cancelled'];

    for (const phase of active) expect(isConsultRunActive({ ...run, phase })).toBe(true);
    for (const phase of inactive) expect(isConsultRunActive({ ...run, phase })).toBe(false);
  });

  test('resetForRuntimeSwitch drops every run and is a no-op when already empty', () => {
    useConsultStore.getState().startRun(startInput());
    useConsultStore.getState().startRun(startInput({ parentSessionId: 'parent-2', runId: 'run-2' }));

    useConsultStore.getState().resetForRuntimeSwitch();

    expect(selectConsultRun(useConsultStore.getState(), 'parent-1')).toBeUndefined();
    expect(selectConsultRun(useConsultStore.getState(), 'parent-2')).toBeUndefined();

    const empty = useConsultStore.getState().runsByParentSessionId;
    useConsultStore.getState().resetForRuntimeSwitch();
    expect(useConsultStore.getState().runsByParentSessionId).toBe(empty);
  });
});
