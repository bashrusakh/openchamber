import { describe, expect, test } from 'bun:test';
import type { MessageQueueTarget, QueuedContextPart, QueuedMessage } from '@/stores/messageQueueStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { ConsultRunFinish, ConsultRunPhase, ConsultRunStartInput } from '@/stores/useConsultStore';
import { createContextPart } from '@/lib/messages/contextParts';
import {
  ConsultationRefusedError,
  type ConsultationHandle,
  type ConsultationResult,
  type ConsultAdvisorProvenance,
  type StartConsultationInput,
} from './runtime';
import {
  CONSULT_HOLD_REASSERT_MS,
  createConsultSubmission,
  type ConsultActingTurn,
  type ConsultSubmissionDeps,
  type ConsultSubmissionResult,
  type SubmitConsultMessageInput,
} from './submission';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const attachment = (): AttachedFile => ({
  id: 'att-1',
  file: new File(['png'], 'shot.png', { type: 'image/png' }),
  dataUrl: 'data:image/png;base64,cG5n',
  mimeType: 'image/png',
  filename: 'shot.png',
  size: 3,
  source: 'local',
});

const contextPart = (): QueuedContextPart => {
  const part = createContextPart({
    kind: 'file-quote',
    fileLabel: 'src/app.ts',
    quote: 'const value = 1;',
    text: 'Why is this here?',
  });
  return { kind: 'context', text: part.text, metadata: part.metadata };
};

const provenance = (overrides?: Partial<ConsultAdvisorProvenance>): ConsultAdvisorProvenance => ({
  index: 0,
  providerID: 'openai',
  modelID: 'gpt-5',
  variant: 'high',
  agent: 'build',
  status: 'ok',
  durationMs: 12,
  ...overrides,
});

const consultationResult = (overrides?: Partial<ConsultationResult>): ConsultationResult => ({
  runId: 'run-1',
  parentSessionId: 'parent',
  mode: 'parallel',
  status: 'ok',
  advisors: [provenance()],
  blocks: [{ text: 'the advisor reply' }],
  durationMs: 40,
  ...overrides,
});

const baseInput = (overrides?: Partial<SubmitConsultMessageInput>): SubmitConsultMessageInput => ({
  parentSessionId: 'parent',
  directory: '/work',
  runtimeKey: 'runtime-1',
  message: {
    content: 'What should we do next? @build',
    text: 'What should we do next?',
    agentMentionName: 'build',
    attachments: [attachment()],
    context: [contextPart()],
  },
  sendConfig: {
    providerID: 'anthropic',
    modelID: 'claude-sonnet',
    agent: 'build',
    variant: 'high',
  },
  advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }],
  mode: 'parallel',
  timeoutMs: 120_000,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type HarnessState = {
  events: string[];
  queueItems: QueuedMessage[];
  queued: Array<{
    target: MessageQueueTarget;
    message: {
      content: string;
      text?: string;
      agentMention?: string;
      attachments?: AttachedFile[];
      context?: QueuedContextPart[];
      sendConfig?: { providerID: string; modelID: string; agent?: string; variant?: string };
    };
  }>;
  holds: boolean[];
  holdOwners: Array<string | undefined>;
  /** Every `setServerHold` request in call order, with its completion state. */
  holdCalls: Array<{ held: boolean; owner?: string; completed: boolean }>;
  /** When set, the next hold request waits on this gate before completing. */
  holdGate: Deferred<void> | null;
  heartbeatActive: boolean;
  heartbeatIntervals: number[];
  heartbeats: Array<() => void>;
  /** Items pushed into the projection right after the enqueue append. */
  foreignAppends: QueuedMessage[];
  /** When set, `takeForSend` resolves with nothing (the item vanished). */
  takeEmpty: boolean;
  holdFailure: boolean;
  addFailure: Error | null;
  addFailureOnce: boolean;
  takeFailure: Error | null;
  takes: number;
  status: 'idle' | 'busy' | 'retry';
  statusFailure: Error | null;
  autoReviewRunning: boolean;
  runtimeKey: string;
  startInputs: StartConsultationInput[];
  consultations: Array<Deferred<ConsultationResult>>;
  runtimeCancels: string[];
  dispatches: ConsultActingTurn[];
  dispatchFailure: Error | null;
  runs: Map<string, { runId: string; phase: ConsultRunPhase }>;
  phaseLog: string[];
  startRunInputs: ConsultRunStartInput[];
  now: number;
  itemCounter: number;
  runCounter: number;
};

type Harness = {
  deps: ConsultSubmissionDeps;
  state: HarnessState;
  submit: (input: SubmitConsultMessageInput) => ReturnType<ReturnType<typeof createConsultSubmission>['submitConsultMessage']>;
  flush: (times?: number) => Promise<void>;
  tickHeartbeat: () => Promise<void>;
  lastConsultation: () => Deferred<ConsultationResult>;
};

const createHarness = (): Harness => {
  const state: HarnessState = {
    events: [],
    queueItems: [],
    queued: [],
    holds: [],
    holdOwners: [],
    holdCalls: [],
    holdGate: null,
    heartbeatActive: false,
    heartbeatIntervals: [],
    heartbeats: [],
    foreignAppends: [],
    takeEmpty: false,
    holdFailure: false,
    addFailure: null,
    addFailureOnce: false,
    takeFailure: null,
    takes: 0,
    status: 'idle',
    statusFailure: null,
    autoReviewRunning: false,
    runtimeKey: 'runtime-1',
    startInputs: [],
    consultations: [],
    runtimeCancels: [],
    dispatches: [],
    dispatchFailure: null,
    runs: new Map(),
    phaseLog: [],
    startRunInputs: [],
    now: 1000,
    itemCounter: 0,
    runCounter: 0,
  };

  const deps: ConsultSubmissionDeps = {
    queue: {
      addToQueue: async (target, message) => {
        state.events.push('queue:add');
        state.queued.push({ target, message });
        if (state.addFailure) {
          if (state.addFailureOnce) state.addFailure = null;
          throw state.addFailure;
        }
        state.itemCounter += 1;
        const item: QueuedMessage = {
          id: `q-${state.itemCounter}`,
          content: message.content,
          text: message.text ?? message.content,
          createdAt: state.now,
        };
        if (message.sendConfig) item.sendConfig = message.sendConfig;
        if (message.agentMention) item.agentMention = message.agentMention;
        if (message.attachments && message.attachments.length > 0) item.attachments = message.attachments;
        if (message.context && message.context.length > 0) item.context = message.context;
        state.queueItems.push(item);
        for (const foreign of state.foreignAppends) state.queueItems.push({ ...foreign });
      },
      removeFromQueue: (target, messageId) => {
        state.events.push(`queue:remove:${messageId}`);
        state.queueItems = state.queueItems.filter((item) => item.id !== messageId);
      },
      takeForSend: async (target, messageId) => {
        state.events.push(`queue:take:${messageId}`);
        state.takes += 1;
        if (state.takeFailure) throw state.takeFailure;
        if (state.takeEmpty) return [];
        const taken = state.queueItems.filter((item) => item.id === messageId);
        state.queueItems = state.queueItems.filter((item) => item.id !== messageId);
        return taken;
      },
      getQueueForTarget: (target) => {
        state.events.push(`queue:read:${target.sessionId}`);
        return [...state.queueItems];
      },
      setServerHold: async (sessionId, held, owner) => {
        state.events.push(`hold:${held ? 'on' : 'off'}:${sessionId}:${owner ?? 'default'}`);
        if (held && state.holdFailure) throw new Error('hold request failed');
        const call = { held, owner, completed: false };
        state.holdCalls.push(call);
        const gate = state.holdGate;
        if (gate) {
          state.holdGate = null;
          await gate.promise;
        }
        call.completed = true;
        state.holds.push(held);
        state.holdOwners.push(owner);
      },
    },
    runs: {
      start: (input) => {
        state.startRunInputs.push(input);
        state.phaseLog.push(`${input.runId}:waiting-admission`);
        state.runs.set(input.parentSessionId, { runId: input.runId, phase: 'waiting-admission' });
      },
      setPhase: (parentSessionId, runId, phase) => {
        const current = state.runs.get(parentSessionId);
        if (!current || current.runId !== runId) return;
        current.phase = phase;
        state.phaseLog.push(`${runId}:${phase}`);
      },
      finish: (parentSessionId, runId, summary: ConsultRunFinish) => {
        const current = state.runs.get(parentSessionId);
        if (!current || current.runId !== runId) return;
        current.phase = summary.phase;
        state.phaseLog.push(`${runId}:finish:${summary.phase}`);
      },
      cancel: (parentSessionId, runId) => {
        const current = state.runs.get(parentSessionId);
        if (!current || current.runId !== runId) return;
        current.phase = 'cancelled';
        state.phaseLog.push(`${runId}:cancel`);
      },
      currentOwner: (parentSessionId) => state.runs.get(parentSessionId)?.runId ?? null,
      currentPhase: (parentSessionId, runId) => {
        const current = state.runs.get(parentSessionId);
        return current && current.runId === runId ? current.phase : null;
      },
    },
    runtime: {
      startConsultation: (input): ConsultationHandle => {
        state.events.push(`runtime:start:${input.runId}`);
        state.startInputs.push(input);
        const gate = deferred<ConsultationResult>();
        state.consultations.push(gate);
        return { runId: input.runId ?? 'unknown', result: gate.promise };
      },
      cancel: async (runId) => {
        state.events.push(`runtime:cancel:${runId}`);
        state.runtimeCancels.push(runId);
      },
    },
    sendActingTurn: async (turn) => {
      state.events.push('dispatch');
      if (state.dispatchFailure) throw state.dispatchFailure;
      state.dispatches.push(turn);
    },
    resolveSessionStatus: () => {
      if (state.statusFailure) throw state.statusFailure;
      return state.status;
    },
    isAutoReviewRunning: () => state.autoReviewRunning,
    runtimeKey: () => state.runtimeKey,
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    createRunId: () => {
      state.runCounter += 1;
      return `run-${state.runCounter}`;
    },
    admissionPollMs: 1,
    scheduleHoldReassert: (callback, intervalMs) => {
      state.heartbeats.push(callback);
      state.heartbeatIntervals.push(intervalMs);
      state.heartbeatActive = true;
      return () => {
        state.heartbeatActive = false;
      };
    },
  };

  const submission = createConsultSubmission(deps);

  const flush = async (times = 8): Promise<void> => {
    for (let index = 0; index < times; index += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };

  return {
    deps,
    state,
    submit: (input) => submission.submitConsultMessage(input),
    flush,
    tickHeartbeat: async () => {
      for (const beat of [...state.heartbeats]) beat();
      await flush();
    },
    lastConsultation: () => {
      const gate = state.consultations[state.consultations.length - 1];
      if (!gate) throw new Error('no consultation was started');
      return gate;
    },
  };
};

const foreignItem = (id: string): QueuedMessage => ({
  id,
  content: 'someone else queued this',
  text: 'someone else queued this',
  createdAt: 0,
});

const receiptCarrier = (turn: ConsultActingTurn) => turn.textPartMetadata?.openchamberConsultReceipt;

const errorOf = (result: ConsultSubmissionResult): string => {
  if (result.status === 'failed' || result.status === 'refused') return result.error;
  throw new Error(`expected a failure result, received ${result.status}`);
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue admission', () => {
  test('acquires the hold before the enqueue, then waits for the head', async () => {
    const harness = createHarness();
    harness.state.queueItems.push(foreignItem('foreign-1'));
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();

    // B2: the hold is awaited before the item exists, so the server's 500 ms
    // dispatch quiet timer can never race the hold round trip. The item then
    // waits behind the foreign head.
    expect(harness.state.events.indexOf('hold:on:parent:consult:run-1')).toBeGreaterThan(-1);
    expect(harness.state.events.indexOf('hold:on:parent:consult:run-1'))
      .toBeLessThan(harness.state.events.indexOf('queue:add'));
    expect(harness.state.queueItems.map((item) => item.id)).toEqual(['foreign-1', 'q-1']);
    expect(harness.state.holds).toEqual([true]);
    expect(harness.state.holdOwners).toEqual(['consult:run-1']);
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.phaseLog).toEqual(['run-1:waiting-admission']);

    // The composer's queue capture shape, exactly: raw content, delivery
    // text, agent mention, attachments, context, and send config.
    expect(harness.state.queued[0].message).toEqual({
      content: 'What should we do next? @build',
      text: 'What should we do next?',
      agentMention: 'build',
      attachments: [attachment()],
      context: [contextPart()],
      sendConfig: { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'build', variant: 'high' },
    });

    // The head clears; admission follows on the next poll.
    harness.state.queueItems = harness.state.queueItems.filter((item) => item.id !== 'foreign-1');
    harness.state.status = 'idle';
    await harness.flush();

    expect(harness.state.takes).toBe(1);
    expect(harness.state.startInputs).toHaveLength(1);
    expect(harness.state.startInputs[0]).toMatchObject({
      parentSessionId: 'parent',
      directory: '/work',
      expectedRuntimeKey: 'runtime-1',
      messageText: 'What should we do next?',
      mode: 'parallel',
      timeoutMs: 120_000,
      runId: 'run-1',
    });

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('re-asserts the hold on the heartbeat until the terminal release', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.holds).toEqual([true]);
    expect(harness.state.heartbeatActive).toBe(true);
    // The default beat is well inside the server's five-minute TTL.
    expect(harness.state.heartbeatIntervals).toEqual([CONSULT_HOLD_REASSERT_MS]);
    expect(CONSULT_HOLD_REASSERT_MS).toBe(2 * 60 * 1000);

    // A long admission wait keeps re-asserting the same owner instead of
    // letting the hold expire.
    await harness.tickHeartbeat();
    await harness.tickHeartbeat();
    expect(harness.state.holds).toEqual([true, true, true]);
    expect(harness.state.holdOwners).toEqual(['consult:run-1', 'consult:run-1', 'consult:run-1']);

    // The fan-out re-asserts once more, and the dispatch releases.
    harness.state.status = 'idle';
    await harness.flush();
    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
    expect(harness.state.holds).toEqual([true, true, true, true, false]);
    expect(harness.state.heartbeatActive).toBe(false);

    // A stopped heartbeat never re-asserts after the terminal release.
    await harness.tickHeartbeat();
    expect(harness.state.holds).toHaveLength(5);
  });

  test('an in-flight re-assert is awaited before the terminal release lands', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.holds).toEqual([true]);

    // The heartbeat's re-assert reaches the transport and stays in flight.
    const gate = deferred<void>();
    harness.state.holdGate = gate;
    await harness.tickHeartbeat();
    expect(harness.state.holdCalls).toEqual([
      { held: true, owner: 'consult:run-1', completed: true },
      { held: true, owner: 'consult:run-1', completed: false },
    ]);

    // The run reaches a terminal path (cancel) while the re-assert is in
    // flight: the release is claimed, but it must not be issued before the
    // re-assert has settled.
    handle.cancel();
    await harness.flush();
    expect(harness.state.events).not.toContain('hold:off:parent:consult:run-1');
    expect(harness.state.holds).toEqual([true]);

    gate.resolve();
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    // The release is the last hold operation to complete: a stale re-assert
    // can never land after it and leave the session held.
    expect(harness.state.holdCalls).toEqual([
      { held: true, owner: 'consult:run-1', completed: true },
      { held: true, owner: 'consult:run-1', completed: true },
      { held: false, owner: 'consult:run-1', completed: true },
    ]);
    expect(harness.state.holds).toEqual([true, true, false]);
    expect(harness.state.events).toContain('hold:off:parent:consult:run-1');

    // A heartbeat that fires after the release never re-asserts.
    await harness.tickHeartbeat();
    expect(harness.state.holdCalls).toHaveLength(3);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a queued re-assert is skipped once the release is claimed', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();

    // Two beats queue up while the first one is still in flight.
    const gate = deferred<void>();
    harness.state.holdGate = gate;
    await harness.tickHeartbeat();
    await harness.tickHeartbeat();
    expect(harness.state.holdCalls.map((call) => call.completed)).toEqual([true, false]);

    handle.cancel();
    await harness.flush();
    gate.resolve();
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    // The queued beat observed the claimed release and never issued its
    // request: only the in-flight re-assert completed before the release.
    expect(harness.state.holdCalls).toEqual([
      { held: true, owner: 'consult:run-1', completed: true },
      { held: true, owner: 'consult:run-1', completed: true },
      { held: false, owner: 'consult:run-1', completed: true },
    ]);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('waits for an authoritatively idle session before the fan-out starts', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);

    harness.state.status = 'idle';
    await harness.flush();
    expect(harness.state.takes).toBe(1);
    expect(harness.state.phaseLog).toContain('run-1:consulting');

    harness.lastConsultation().resolve(consultationResult());
    await handle.result;
  });

  test('the item disappearing while waiting is delivered-raw: no restore and no re-send', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    const enqueuedCount = harness.state.queued.length;

    // The hold lapsed and the server delivered the raw message (or another
    // client removed it): the projection no longer has the item.
    harness.state.queueItems = [];
    await harness.flush();
    const result = await handle.result;

    expect(result).toEqual({ status: 'delivered-raw', runId: 'run-1', queueItemRestored: false });
    expect(harness.state.takes).toBe(0);
    expect(harness.state.dispatches).toHaveLength(0);
    // Never re-sent and never restored.
    expect(harness.state.queued).toHaveLength(enqueuedCount);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });

  test('a take that resolves with nothing is delivered-raw too', async () => {
    const harness = createHarness();
    harness.state.takeEmpty = true;
    const handle = harness.submit(baseInput());
    await harness.flush();

    const result = await handle.result;

    expect(result.status).toBe('delivered-raw');
    if (result.status !== 'delivered-raw') throw new Error('expected delivered-raw');
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.dispatches).toHaveLength(0);
    // Never restored and never re-sent.
    expect(harness.state.queued).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('an unattributable concurrent append is never taken and is left queued', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';
    // Two foreign appends with the same content land with the enqueue, so the
    // pre-enqueue snapshot cannot attribute any of the three ids.
    harness.state.foreignAppends = [
      { id: 'foreign-a', content: baseInput().message.content, text: 'x', createdAt: 0 },
      { id: 'foreign-b', content: baseInput().message.content, text: 'y', createdAt: 0 },
    ];
    const handle = harness.submit(baseInput());
    await harness.flush();

    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.queueItemRestored).toBe(true);
    expect(harness.state.takes).toBe(0);
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('a superseding run releases only its own owner; the new run holds its own', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.holds).toEqual([true]);

    // A second submission for the same parent replaces the run record before
    // it reaches its own fan-out.
    harness.deps.runs.start({
      parentSessionId: 'parent',
      runId: 'run-2',
      mode: 'parallel',
      timeoutMs: 120_000,
      advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }],
    });
    await harness.flush();

    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.takes).toBe(0);
    // Owner scoping makes the release safe: it clears run-1's slot only, and
    // run-2 (a real submission) asserts `consult:run-2` separately.
    expect(harness.state.holdOwners).toEqual(['consult:run-1', 'consult:run-1']);
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.events).toContain('hold:off:parent:consult:run-1');
    expect(harness.state.heartbeatActive).toBe(false);
  });
});

describe('auto-review exclusion', () => {
  test('refuses at start while auto-review runs: nothing queued, nothing held', async () => {
    const harness = createHarness();
    harness.state.autoReviewRunning = true;

    const handle = harness.submit(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('auto-review-active');
    expect(result.runId).toBe(handle.runId);
    expect(result.error).toContain('automatic review loop');
    expect(result.rejections).toEqual([]);
    expect(result.queueItemRestored).toBe(false);

    // The guard runs before the hold and the enqueue, so there is nothing for
    // the caller to restore and no run record to report.
    expect(harness.state.startRunInputs).toHaveLength(0);
    expect(harness.state.queued).toEqual([]);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatches).toHaveLength(0);
  });

  test('aborts a waiting admission when auto-review starts: one hold release, never a dispatch', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.queueItems.map((item) => item.id)).toEqual(['q-1']);
    expect(harness.state.holds).toEqual([true]);
    expect(harness.state.heartbeatActive).toBe(true);

    // Auto-review takes the parent over while the consult waits for admission.
    harness.state.autoReviewRunning = true;
    await harness.flush();

    const result = await handle.result;
    // The cancel path's queue-item semantics: the untaken item is removed, so
    // the caller restores the composer from a cancelled result.
    expect(result.status).toBe('cancelled');
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatches).toHaveLength(0);
    // Exactly one release, with the heartbeat stopped by it.
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.holdOwners).toEqual(['consult:run-1', 'consult:run-1']);
    expect(harness.state.heartbeatActive).toBe(false);

    // Idempotent: a late cancel and a heartbeat tick change nothing.
    handle.cancel();
    await harness.tickHeartbeat();
    await harness.flush();
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.runtimeCancels).toEqual([]);
  });

  test('auto-review wins over an admissible queue head: the item is never taken', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();

    // The item is the queue head and the session is idle, but auto-review now
    // owns the parent: admission must not take it.
    harness.state.status = 'idle';
    harness.state.autoReviewRunning = true;
    await harness.flush();

    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.queueItems).toEqual([]);
  });
});

describe('dispatch', () => {
  test('takes, starts the exact consultation, and dispatches with the original config', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    expect(harness.state.takes).toBe(1);
    expect(harness.state.startInputs[0]).toMatchObject({
      parentSessionId: 'parent',
      directory: '/work',
      expectedRuntimeKey: 'runtime-1',
      messageText: 'What should we do next?',
      attachments: [{ id: 'att-1', type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,cG5n' }],
      advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }],
      mode: 'parallel',
      timeoutMs: 120_000,
      runId: 'run-1',
    });

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    expect(harness.state.dispatches).toHaveLength(1);
    const turn = harness.state.dispatches[0];

    // The acting turn keeps the original message and configuration; the
    // guidance is turn-scoped `system`, never part of the message text.
    expect(turn.sendConfig).toEqual({
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      agent: 'build',
      variant: 'high',
    });
    expect(turn.message.text).toBe('What should we do next?');
    expect(turn.message.agentMentionName).toBe('build');
    expect(turn.message.attachments).toEqual([attachment()]);
    expect(turn.message.context).toEqual([contextPart()]);
    expect(turn.target).toEqual({ runtimeKey: 'runtime-1', directory: '/work', sessionId: 'parent' });

    // Anonymous untrusted blocks in the reminder frame.
    expect(turn.system.startsWith('<system-reminder>')).toBe(true);
    expect(turn.system).toContain('ADVISOR 1:');
    expect(turn.system).toContain('the advisor reply');
    expect(turn.system).toContain('untrusted data');
    expect(turn.system).toContain('newer evidence wins');
    expect(turn.system).not.toContain('openai');
    expect(turn.system).not.toContain('gpt-5');

    // The bounded receipt rides the primary text part and carries provenance.
    expect(receiptCarrier(turn)).toMatchObject({
      runID: 'run-1',
      mode: 'parallel',
      acting: 'anthropic/claude-sonnet',
      degraded: false,
      advisors: [{ model: 'openai/gpt-5', variant: 'high', status: 'ok', durationMs: 12 }],
    });

    // Hold lifecycle: asserted at enqueue, re-asserted for the fan-out, and
    // released once after the dispatch.
    expect(harness.state.holds).toEqual([true, true, false]);
    expect(harness.state.phaseLog).toEqual([
      'run-1:waiting-admission',
      'run-1:consulting',
      'run-1:settling',
      'run-1:dispatching',
      'run-1:finish:done',
    ]);
  });

  test('a partial result dispatches with the successful advisors only', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    harness.lastConsultation().resolve(consultationResult({
      status: 'partial',
      blocks: [{ text: 'the usable advice' }],
      advisors: [
        provenance(),
        provenance({ index: 1, providerID: 'google', modelID: 'gemini', status: 'failed', reason: 'provider exploded' }),
      ],
    }));
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    const turn = harness.state.dispatches[0];
    expect(turn.system).toContain('the usable advice');
    expect(turn.system).not.toContain('provider exploded');
    expect(receiptCarrier(turn)).toMatchObject({
      degraded: false,
      advisors: [
        { model: 'openai/gpt-5', status: 'ok' },
        { model: 'google/gemini', status: 'failed', reason: 'provider exploded' },
      ],
    });
  });

  test('an all-fail result dispatches the explicit degraded notice', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    harness.lastConsultation().resolve(consultationResult({
      status: 'degraded',
      blocks: [],
      advisors: [provenance({ status: 'failed', reason: 'boom' })],
    }));
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    const turn = harness.state.dispatches[0];
    expect(turn.system).toContain('no usable advisor output');
    expect(turn.system).toContain('Proceed normally');
    expect(receiptCarrier(turn)).toMatchObject({ degraded: true });
    expect(harness.state.phaseLog).toContain('run-1:finish:done');
  });

  test('a failed acting send marks the run failed and releases the hold', async () => {
    const harness = createHarness();
    harness.state.dispatchFailure = new Error('prompt rejected');
    const handle = harness.submit(baseInput());
    await harness.flush();

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('prompt rejected');
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, true, false]);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });
});

describe('cancellation and failures', () => {
  test('cancel before admission removes the queued item and never dispatches', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.takes).toBe(0);

    handle.cancel();
    handle.cancel();
    // The heartbeat stops synchronously on cancel; the run task releases.
    expect(harness.state.heartbeatActive).toBe(false);
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.phaseLog).toContain('run-1:finish:cancelled');
  });

  test('cancel after the item was taken cancels the runtime and never dispatches', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.startInputs).toHaveLength(1);

    handle.cancel();
    handle.cancel();
    await harness.flush();
    expect(harness.state.runtimeCancels).toEqual(['run-1']);

    // The real runtime resolves a cancelled result; the fake mirrors it.
    harness.lastConsultation().resolve(consultationResult({ status: 'cancelled', blocks: [] }));
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a runtime change while waiting stops without touching the queue or the hold', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();

    harness.state.runtimeKey = 'runtime-2';
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('runtime changed');
    expect(harness.state.takes).toBe(0);
    expect(harness.state.dispatches).toHaveLength(0);
    // The item and the hold belong to the runtime that created them; the
    // heartbeat stops so nothing beats against the new runtime.
    expect(harness.state.queueItems.map((item) => item.id)).toEqual(['q-1']);
    expect(harness.state.holds).toEqual([true]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
  });

  test('a runtime change during the fan-out skips the dispatch', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.takes).toBe(1);

    harness.state.runtimeKey = 'runtime-2';
    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('runtime changed');
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, true]);
  });

  test('a start refusal restores the taken item and releases the hold', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.queueItems).toEqual([]);

    const rejections = [
      { index: 0, code: 'model-unknown' as const, message: 'Model "openai/gpt-5" is not available' },
    ];
    harness.lastConsultation().reject(new ConsultationRefusedError(
      'invalid-advisor',
      'The advisor selection is not available on this runtime',
      rejections,
    ));
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('invalid-advisor');
    expect(result.rejections).toEqual(rejections);
    expect(result.queueItemRestored).toBe(true);
    expect(harness.state.dispatches).toHaveLength(0);

    // The message is back in the queue with its payload intact.
    expect(harness.state.queueItems).toHaveLength(1);
    expect(harness.state.queueItems[0]).toMatchObject({
      content: 'What should we do next? @build',
      text: 'What should we do next?',
      agentMention: 'build',
      sendConfig: { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'build', variant: 'high' },
    });
    expect(harness.state.queueItems[0].attachments).toEqual([attachment()]);
    expect(harness.state.queueItems[0].context).toEqual([contextPart()]);
    expect(harness.state.holds).toEqual([true, true, false]);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });

  test('a cancel wins over a refusal that lands after it', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    handle.cancel();
    harness.lastConsultation().reject(new ConsultationRefusedError(
      'no-settled-context',
      'The parent session has no settled context to fork from',
    ));
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    // The cancelled message is not restored for normal delivery.
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a failed take leaves the item queued and releases the hold', async () => {
    const harness = createHarness();
    harness.state.takeFailure = new Error('take request failed');
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('take request failed');
    expect(harness.state.dispatches).toHaveLength(0);
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('an unexpected failure leaves the run terminal so auto-review is not blocked', async () => {
    const harness = createHarness();
    harness.state.statusFailure = new Error('status resolver exploded');
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('status resolver exploded');
    // The run record must be terminal even on the unexpected-error path: a
    // stuck non-terminal record would make the auto-review exclusion guard
    // refuse forever.
    expect(harness.state.runs.get('parent')?.phase).toBe('failed');
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('a failed hold request never enqueues the raw message', async () => {
    const harness = createHarness();
    harness.state.holdFailure = true;
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('hold request failed');
    expect(harness.state.takes).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    // B2: the hold is acquired before the item exists, so a failed hold means
    // the message was never queued and can never be delivered raw.
    expect(harness.state.queued).toEqual([]);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('hold release is idempotent across cancel and the terminal path', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();

    handle.cancel();
    await harness.flush();
    handle.cancel();
    await harness.flush();
    await handle.result;

    expect(harness.state.holds).toEqual([true, false]);
  });

  test('a rollback path is never a dispatch: the result keeps the original run id', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.lastConsultation().resolve(consultationResult({ status: 'cancelled', blocks: [] }));

    const result = await handle.result;
    expect(result.runId).toBe(handle.runId);
    expect(harness.state.dispatches).toHaveLength(0);
  });
});
