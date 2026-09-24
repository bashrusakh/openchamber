import { describe, expect, test } from 'bun:test';
import type { ConsultDispatchOutcome, ConsultResolveOutcome, MessageQueueTarget, QueuedContextPart, QueuedMessage } from '@/stores/messageQueueStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import type { ConsultRunFinish, ConsultRunPhase, ConsultRunStartInput } from '@/stores/useConsultStore';
import { createContextPart } from '@/lib/messages/contextParts';
import { CONSULT_BACKEND_PROTOCOL_VERSION } from './capability';
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
  type ConsultSubmissionDeps,
  type ConsultSubmissionResult,
  type SubmitConsultMessageInput,
} from './submission';
import { createMessageQueueTarget } from '@/stores/messageQueueStore';

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
  /** addToQueue answers undefined (no authoritative id). */
  enqueueReturnsNothing: boolean;
  /** The enqueued item is dropped from the projection before addToQueue returns. */
  discardEnqueuedItem: boolean;
  /** When set, `takeForSend` resolves with nothing (the item vanished). */
  takeEmpty: boolean;
  holdFailure: boolean;
  addFailure: Error | null;
  addFailureOnce: boolean;
  claimFailure: Error | null;
  /** A queued refusal (e.g. not-idle) the fake claim keeps throwing until cleared. */
  claimRefusal: Error | null;
  claims: number;
  payloadCalls: Array<{ system?: string; textPartMetadata?: unknown }>;
  payloadFailure: Error | null;
  dispatchConsultCalls: number;
  dispatchConsultBusy: boolean;
  /** When set, the next dispatch answers this exact structured outcome. */
  dispatchConsultOutcome: ConsultDispatchOutcome | null;
  /** When set, EVERY dispatch answers `claim-lost` until cleared (exhaustion scenarios). */
  dispatchConsultClaimLost: boolean;
  /** With `dispatchConsultClaimLost`: the claim was lost to this foreign owner, who also left a witness. */
  foreignClaimOwner: string | null;
  /** With `foreignClaimOwner`: the foreign owner also left a dispatch attempt on the item. */
  foreignClaimWitness: boolean;
  /** When set, the next dispatch request waits on this gate. */
  dispatchConsultGate: { promise: Promise<ConsultDispatchOutcome> } | null;
  dispatchConsultFailure: Error | null;
  /** When set, `resolveConsultItem` answers this exact structured outcome. */
  resolveConsultOutcome: ConsultResolveOutcome | null;
  /** When set, `resolveConsultItem` throws (the resume must refuse without resuming). */
  resolveConsultFailure: Error | null;
  /** Every `resolveConsultItem` call in order. */
  resolveConsultCalls: Array<{ sessionId: string; messageId: string }>;
  prevalidations: Array<{ parentSessionId: string; directory: string }>;
  prevalidationRefusal: Error | null;
  /** When set, verifyCapability answers this refusal. */
  capabilityRefusal: { available: false; reason: string; message?: string } | null;
  capabilityChecks: number;
  /** One-shot: the next runs.finish throws (exercises the outer catch). */
  finishFailureOnce: Error | null;
  /** One-shot: the next runs.setPhase throws (exercises the resume outer catch). */
  setPhaseFailureOnce: Error | null;
  /** Every `runs.updateAdvisor` call in order (F5 live advisor rows). */
  advisorUpdates: Array<{ runId: string; index: number; status?: string; durationMs?: number; reason?: string }>;
  status: 'idle' | 'busy' | 'retry';
  statusFailure: Error | null;
  autoReviewRunning: boolean;
  runtimeKey: string;
  /** What `fetchSessionKnowledge` answers: text, a rejection, or empty. */
  knowledgeText: string | null;
  knowledgeRejection: Error | null;
  knowledgeCalls: Array<{ directory: string; sessionId: string }>;
  startInputs: StartConsultationInput[];
  consultations: Array<Deferred<ConsultationResult>>;
  runtimeCancels: string[];
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
  resume: ReturnType<typeof createConsultSubmission>['resumeConsultItem'];
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
    enqueueReturnsNothing: false,
    discardEnqueuedItem: false,
    takeEmpty: false,
    holdFailure: false,
    addFailure: null,
    addFailureOnce: false,
    claimFailure: null,
    claimRefusal: null,
    claims: 0,
    payloadCalls: [],
    payloadFailure: null,
    dispatchConsultCalls: 0,
    dispatchConsultBusy: false,
    dispatchConsultOutcome: null,
    dispatchConsultClaimLost: false,
    foreignClaimOwner: null,
    foreignClaimWitness: false,
    dispatchConsultGate: null,
    dispatchConsultFailure: null,
    resolveConsultOutcome: null,
    resolveConsultFailure: null,
    resolveConsultCalls: [],
    prevalidations: [],
    prevalidationRefusal: null,
    capabilityRefusal: null,
    capabilityChecks: 0,
    finishFailureOnce: null,
    setPhaseFailureOnce: null,
    advisorUpdates: [],
    status: 'idle',
    statusFailure: null,
    autoReviewRunning: false,
    runtimeKey: 'runtime-1',
    knowledgeText: null,
    knowledgeRejection: null,
    knowledgeCalls: [],
    startInputs: [],
    consultations: [],
    runtimeCancels: [],
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
        if (state.discardEnqueuedItem) {
          state.queueItems = state.queueItems.filter((entry) => entry.id !== item.id);
        }
        return state.enqueueReturnsNothing ? undefined : item;
      },
      removeFromQueue: (target, messageId) => {
        state.events.push(`queue:remove:${messageId}`);
        state.queueItems = state.queueItems.filter((item) => item.id !== messageId);
      },
      claimConsultItem: async (target, messageId, owner) => {
        state.events.push(`queue:claim:${messageId}:${owner ?? 'default'}`);
        state.claims += 1;
        if (state.claimFailure) throw state.claimFailure;
        if (state.claimRefusal) throw state.claimRefusal;
        const item = state.queueItems.find((entry) => entry.id === messageId);
        if (!item) throw new Error('cannot claim queued message: not found');
        item.claimed = { owner: owner ?? 'default', claimedAt: state.now };
        return item;
      },
      setConsultItemPayload: async (target, messageId, owner, consult) => {
        state.events.push(`queue:payload:${messageId}`);
        state.payloadCalls.push(consult);
        if (state.payloadFailure) throw state.payloadFailure;
        const item = state.queueItems.find((entry) => entry.id === messageId);
        if (!item) throw new Error('cannot update consult payload: not found');
        item.consult = { ...item.consult, ...consult };
      },
      dispatchConsultItem: async (target, messageId) => {
        state.events.push(`queue:dispatch-consult:${messageId}`);
        state.dispatchConsultCalls += 1;
        if (state.dispatchConsultGate) {
          const gate = state.dispatchConsultGate;
          state.dispatchConsultGate = null;
          return gate.promise;
        }
        if (state.dispatchConsultBusy) return { status: 'busy' };
        if (state.dispatchConsultClaimLost) {
          // Model the foreign takeover the claim loss means: the item's
          // reservation moves to the foreign owner, who (with the witness
          // flag) also left a dispatch attempt on it.
          const lostItem = state.queueItems.find((entry) => entry.id === messageId);
          if (lostItem && state.foreignClaimOwner) {
            lostItem.claimed = { owner: state.foreignClaimOwner, claimedAt: state.now };
            if (state.foreignClaimWitness) lostItem.consult = { ...lostItem.consult, textPartMetadata: { openchamberConsultReceipt: { runID: 'foreign-run' } } };
          }
          return { status: 'claim-lost' };
        }
        if (state.dispatchConsultOutcome) {
          // One-shot: the retry paths must observe the next real outcome.
          const outcome = state.dispatchConsultOutcome;
          state.dispatchConsultOutcome = null;
          return outcome;
        }
        if (state.dispatchConsultFailure) throw state.dispatchConsultFailure;
        const item = state.queueItems.find((entry) => entry.id === messageId);
        if (!item) return { status: 'not-found' };
        state.queueItems = state.queueItems.filter((entry) => entry.id !== messageId);
        return { status: 'dispatched', item };
      },
      resolveConsultItem: async (target, messageId) => {
        state.events.push(`queue:resolve-consult:${messageId}`);
        state.resolveConsultCalls.push({ sessionId: target.sessionId, messageId });
        if (state.resolveConsultFailure) throw state.resolveConsultFailure;
        return state.resolveConsultOutcome ?? { status: 'unresolved', recoverable: true };
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
        if (state.setPhaseFailureOnce) {
          const failure = state.setPhaseFailureOnce;
          state.setPhaseFailureOnce = null;
          throw failure;
        }
        const current = state.runs.get(parentSessionId);
        if (!current || current.runId !== runId) return;
        current.phase = phase;
        state.phaseLog.push(`${runId}:${phase}`);
      },
      finish: (parentSessionId, runId, summary: ConsultRunFinish) => {
        if (state.finishFailureOnce) {
          const failure = state.finishFailureOnce;
          state.finishFailureOnce = null;
          throw failure;
        }
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
      updateAdvisor: (parentSessionId, runId, index, update) => {
        const current = state.runs.get(parentSessionId);
        if (!current || current.runId !== runId) return;
        state.advisorUpdates.push({ runId, index, ...update });
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
      // The fake prevalidation succeeds unless the advisor list is invalid:
      // it mirrors the real one's surface/context checks closely enough for
      // the harness, and the refusal contract is asserted via a refusal flag.
      prevalidateConsultation: async (input) => {
        state.events.push('runtime:prevalidate');
        state.prevalidations.push(input);
        if (state.prevalidationRefusal) throw state.prevalidationRefusal;
      },
    },
    resolveSessionStatus: () => {
      if (state.statusFailure) throw state.statusFailure;
      return state.status;
    },
    fetchSessionKnowledge: async (directory, sessionId) => {
      state.knowledgeCalls.push({ directory, sessionId });
      if (state.knowledgeRejection) throw state.knowledgeRejection;
      return { text: state.knowledgeText ?? '' };
    },
    isAutoReviewRunning: () => state.autoReviewRunning,
    verifyCapability: async () => {
      state.capabilityChecks += 1;
      if (state.capabilityRefusal) return state.capabilityRefusal;
      return { available: true };
    },
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
    resume: (target, item, options) => submission.resumeConsultItem(target, item, options),
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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.phaseLog).toEqual(['run-1:waiting-admission']);

    // The composer's queue capture shape, exactly: raw content, delivery
    // text, agent mention, attachments, context, and send config — marked
    // consult so the generic dispatcher never delivers it.
    expect(harness.state.queued[0].message).toEqual({
      content: 'What should we do next? @build',
      text: 'What should we do next?',
      agentMention: 'build',
      attachments: [attachment()],
      context: [contextPart()],
      sendConfig: { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'build', variant: 'high' },
      kind: 'consult',
    });

    // The head clears; admission follows on the next poll.
    harness.state.queueItems = harness.state.queueItems.filter((item) => item.id !== 'foreign-1');
    harness.state.status = 'idle';
    await harness.flush();

    expect(harness.state.claims).toBe(1);
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
    // The server released this owner's hold on the successful dispatch, so
    // the submission never issues its own release after it.
    expect(harness.state.holds).toEqual([true, true, true, true]);
    expect(harness.state.heartbeatActive).toBe(false);

    // A stopped heartbeat never re-asserts after the terminal release.
    await harness.tickHeartbeat();
    expect(harness.state.holds).toHaveLength(4);
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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);

    harness.state.status = 'idle';
    await harness.flush();
    expect(harness.state.claims).toBe(1);
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
    expect(harness.state.claims).toBe(0);
    // Never re-sent and never restored.
    expect(harness.state.queued).toHaveLength(enqueuedCount);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });

  test('a claim that resolves with nothing is delivered-raw too', async () => {
    const harness = createHarness();
    // The item vanishes from the projection right after admission: the claim
    // then cannot find it, mirroring the take-empty edge of the old flow.
    harness.state.status = 'busy';
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.status = 'idle';
    harness.state.queueItems = [];
    await harness.flush();

    const result = await handle.result;

    expect(result.status).toBe('delivered-raw');
    if (result.status !== 'delivered-raw') throw new Error('expected delivered-raw');
    expect(result.queueItemRestored).toBe(false);
    // Never restored and never re-sent.
    expect(harness.state.queued).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('advisors receive the same current-message context parts as the acting turn (REQ-4)', async () => {
    const harness = createHarness();
    const metadata = { openchamberContext: { kind: 'file-quote' as const, fileLabel: 'src/app.ts', quote: 'const value = 1;', text: 'Why?' } };
    const context = [
      { kind: 'context' as const, text: 'the quoted fragment', metadata, instructions: 'how to read it' },
      { kind: 'synthetic' as const, text: 'conflict payload' },
    ];
    const handle = harness.submit(baseInput({ message: { ...baseInput().message, context } }));
    await harness.flush();

    const advisorInput = harness.state.startInputs[0];
    expect(advisorInput.messageText).toBe('What should we do next?');
    // The instruction goes out as its own synthetic part before the context
    // part, which keeps its metadata; a synthetic context part stays synthetic.
    expect(advisorInput.additionalParts).toEqual([
      { text: 'how to read it', synthetic: true },
      { text: 'the quoted fragment', synthetic: true, metadata },
      { text: 'conflict payload', synthetic: true },
    ]);

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('advisors receive the standing session knowledge as a synthetic prefix part (advisor parity)', async () => {
    const harness = createHarness();
    harness.state.knowledgeText = 'Pinned project knowledge';
    const handle = harness.submit(baseInput());
    await harness.flush();

    // Resolved once per run against the parent session.
    expect(harness.state.knowledgeCalls).toEqual([{ directory: '/work', sessionId: 'parent' }]);
    // Same order as a UI send: the knowledge block reads as background before
    // the message's own captured context.
    const advisorInput = harness.state.startInputs[0];
    const context = contextPart();
    if (context.kind !== 'context') throw new Error('fixture must be a context part');
    expect(advisorInput.additionalParts).toEqual([
      { text: 'Pinned project knowledge', synthetic: true, systemContext: 'session-knowledge' },
      { text: context.text, synthetic: true, metadata: context.metadata },
    ]);

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('empty knowledge leaves the advisor parts byte-identical to today', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    expect(harness.state.knowledgeCalls).toHaveLength(1);
    const advisorInput = harness.state.startInputs[0];
    const context = contextPart();
    if (context.kind !== 'context') throw new Error('fixture must be a context part');
    expect(advisorInput.additionalParts).toEqual([
      { text: context.text, synthetic: true, metadata: context.metadata },
    ]);

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('a failing knowledge fetch never fails the consult: advisors are sent without it', async () => {
    const harness = createHarness();
    harness.state.knowledgeRejection = new Error('knowledge endpoint down');
    const handle = harness.submit(baseInput());
    await harness.flush();

    expect(harness.state.startInputs).toHaveLength(1);
    const context = contextPart();
    if (context.kind !== 'context') throw new Error('fixture must be a context part');
    expect(harness.state.startInputs[0].additionalParts).toEqual([
      { text: context.text, synthetic: true, metadata: context.metadata },
    ]);

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('resume parity: the resumed fan-out carries the knowledge prefix too', async () => {
    const harness = createHarness();
    const item: QueuedMessage = {
      id: 'q-stranded',
      content: 'What should we do next? @build',
      text: 'What should we do next?',
      agentMention: 'build',
      createdAt: 500,
      kind: 'consult' as const,
      recoverable: true as const,
      context: [contextPart()],
      sendConfig: { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'build', variant: 'high' },
    };
    const target = createMessageQueueTarget('parent', '/work', 'runtime-1');
    if (!target) throw new Error('target fixture failed');
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    harness.state.knowledgeText = 'Pinned project knowledge';
    const pending = harness.resume(
      target,
      item,
      { advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }], mode: 'parallel', timeoutMs: 120_000 },
    );
    await harness.flush();
    expect(harness.state.startInputs).toHaveLength(1);
    harness.lastConsultation().resolve(consultationResult());
    const result = await pending;

    expect(result.status).toBe('dispatched');
    expect(harness.state.knowledgeCalls).toEqual([{ directory: '/work', sessionId: 'parent' }]);
    const context = contextPart();
    if (context.kind !== 'context') throw new Error('fixture must be a context part');
    expect(harness.state.startInputs[0].additionalParts).toEqual([
      { text: 'Pinned project knowledge', synthetic: true, systemContext: 'session-knowledge' },
      { text: context.text, synthetic: true, metadata: context.metadata },
    ]);
  });

  test('the authoritative id returned by addToQueue flows into the claim', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    // The fake returns q-1; the claim must target exactly that id.
    expect(harness.state.events).toContain('queue:claim:q-1:consult:run-1');
    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('addToQueue without an id fails clearly and never guesses one', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';
    harness.state.enqueueReturnsNothing = true;
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.error).toContain('could not be identified');
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('an item gone from the projection right after the enqueue is delivered-raw', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';
    harness.state.discardEnqueuedItem = true;
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result).toEqual({ status: 'delivered-raw', runId: 'run-1', queueItemRestored: false });
    expect(harness.state.claims).toBe(0);
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
    expect(harness.state.claims).toBe(0);
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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
  });

  test('a capability refusal happens before anything is held or queued', async () => {
    const harness = createHarness();
    harness.state.capabilityRefusal = { available: false, reason: 'version-unsupported' };
    const handle = harness.submit(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('capability-unavailable');
    expect(result.error).toContain('1.18.29');
    expect(result.error).toContain('OpenCode');
    expect(result.rejections).toEqual([]);
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.queued).toEqual([]);
    expect(harness.state.claims).toBe(0);
  });

  test('a missing backend consult protocol refuses with a backend diagnosis, never an OpenCode one', async () => {
    const harness = createHarness();
    // The OpenCode version would pass; only the backend protocol is absent.
    harness.state.capabilityRefusal = { available: false, reason: 'protocol-missing' };
    const handle = harness.submit(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('capability-unavailable');
    // The reason decides the diagnosis: name the backend consult protocol, not
    // an OpenCode version that was never the problem.
    expect(result.error).toContain('OpenChamber backend');
    expect(result.error).toContain('consult queue protocol');
    expect(result.error).not.toContain('OpenCode');
    expect(result.rejections).toEqual([]);
    expect(result.queueItemRestored).toBe(false);

    // The gate runs before the hold and the enqueue: no hold, no claim, no add.
    expect(harness.state.capabilityChecks).toBe(1);
    expect(harness.state.queued).toHaveLength(0);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.holdCalls).toEqual([]);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('an old backend consult protocol refuses naming the required protocol version, no enqueue', async () => {
    const harness = createHarness();
    harness.state.capabilityRefusal = { available: false, reason: 'protocol-unsupported' };
    const handle = harness.submit(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('capability-unavailable');
    expect(result.error).toContain('OpenChamber backend');
    expect(result.error).toContain('consult protocol');
    expect(result.error).toContain(`version ${CONSULT_BACKEND_PROTOCOL_VERSION}`);
    expect(result.error).not.toContain('OpenCode');
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.capabilityChecks).toBe(1);
    expect(harness.state.queued).toHaveLength(0);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.holdCalls).toEqual([]);
    expect(harness.state.claims).toBe(0);
  });

  test('a verified capability proceeds into the normal flow', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.capabilityChecks).toBe(1);
    expect(harness.state.holds.length).toBeGreaterThanOrEqual(1);
    expect(harness.state.holds[0]).toBe(true);
    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
  });

  test('a prevalidation refusal happens before the hold and the enqueue', async () => {
    const harness = createHarness();
    harness.state.prevalidationRefusal = new ConsultationRefusedError(
      'invalid-advisor',
      'The advisor selection is not available on this runtime',
      [{ index: 0, code: 'model-unknown', message: 'Model "openai/gpt-5" is not available' }],
    );

    const handle = harness.submit(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('invalid-advisor');
    expect(result.rejections).toEqual([
      { index: 0, code: 'model-unknown', message: 'Model "openai/gpt-5" is not available' },
    ]);
    expect(result.queueItemRestored).toBe(false);

    // F2: the refusal lands while nothing is queued and nothing is held — the
    // message returns to the composer untouched, never a normal queued send.
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.queued).toEqual([]);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.queueItems).toEqual([]);
  });
});

describe('dispatch', () => {
  test('claims, starts the exact consultation, merges the payload, and dispatches via the consult route', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();

    expect(harness.state.claims).toBe(1);
    expect(harness.state.startInputs[0]).toMatchObject({
      parentSessionId: 'parent',
      directory: '/work',
      expectedRuntimeKey: 'runtime-1',
      messageText: 'What should we do next?',
      attachments: [{ type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,cG5n' }],
      advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }],
      mode: 'parallel',
      timeoutMs: 120_000,
      runId: 'run-1',
    });

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    // The settled consultation went to the claimed item through the payload
    // route, then the item was dispatched on its own route.
    expect(harness.state.payloadCalls).toHaveLength(1);
    const payload = harness.state.payloadCalls[0];
    expect(payload.system?.startsWith('<system-reminder>')).toBe(true);
    expect(payload.system).toContain('ADVISOR 1:');
    expect(payload.system).toContain('the advisor reply');
    expect(payload.system).toContain('untrusted data');
    expect(payload.system).toContain('newer evidence wins');
    expect(payload.system).not.toContain('openai');
    expect(payload.system).not.toContain('gpt-5');

    // The bounded receipt rides the primary text part and carries provenance.
    const metadata = payload.textPartMetadata as { openchamberConsultReceipt?: Record<string, unknown> };
    expect(metadata.openchamberConsultReceipt).toMatchObject({
      runID: 'run-1',
      mode: 'parallel',
      acting: 'anthropic/claude-sonnet',
      degraded: false,
      advisors: [{ model: 'openai/gpt-5', variant: 'high', status: 'ok', durationMs: 12 }],
    });

    // The consult item was dispatched (and removed) through its own route,
    // not through a raw sendActingTurn send.
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain(`queue:payload:q-1`);
    expect(harness.state.events).toContain(`queue:dispatch-consult:q-1`);

    // Hold lifecycle: asserted at enqueue, re-asserted for the fan-out, and
    // released by the server on the successful dispatch (no extra release).
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.phaseLog).toEqual([
      'run-1:waiting-admission',
      'run-1:consulting',
      'run-1:settling',
      'run-1:dispatching',
      'run-1:finish:done',
    ]);
  });

  test('advisor file parts drop the composer attachment id, which OpenCode rejects', async () => {
    const harness = createHarness();
    const note: AttachedFile = {
      id: '1790036758821-j7tq1ja47vr',
      file: new File(['A'], 'note.txt', { type: 'text/plain' }),
      dataUrl: 'data:text/plain;base64,QQ==',
      mimeType: 'text/plain',
      filename: 'note.txt',
      size: 1,
      source: 'local',
    };

    const handle = harness.submit(baseInput({
      message: { content: 'What is in this note?', text: 'What is in this note?', attachments: [note] },
    }));
    await harness.flush();

    // The acting/queue payload path keeps the composer attachment untouched.
    expect(harness.state.queued[0].message.attachments).toEqual([note]);

    // The advisor runtime forwards these verbatim as `client.sendMessage`'s
    // `files`, exactly like the acting server path's `toFilePart`
    // (packages/web/server/lib/message-queue/runtime.js): type/mime/url/filename.
    // A composer attachment id is not an OpenCode part id (`prt...`), so
    // forwarding one makes every advisor send fail with
    // `400 BadRequest: Expected a string starting with "prt"`.
    const advisorFiles = harness.state.startInputs[0].attachments;
    expect(advisorFiles).toEqual([
      { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,QQ==', filename: 'note.txt' },
    ]);
    expect(advisorFiles?.[0] && Object.prototype.hasOwnProperty.call(advisorFiles[0], 'id')).toBe(false);

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
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
    const payload = harness.state.payloadCalls[0];
    expect(payload.system).toContain('the usable advice');
    expect(payload.system).not.toContain('provider exploded');
    const metadata = payload.textPartMetadata as { openchamberConsultReceipt?: Record<string, unknown> };
    expect(metadata.openchamberConsultReceipt).toMatchObject({
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
    const payload = harness.state.payloadCalls[0];
    expect(payload.system).toContain('no usable advisor output');
    expect(payload.system).toContain('Proceed normally');
    const metadata = payload.textPartMetadata as { openchamberConsultReceipt?: Record<string, unknown> };
    expect(metadata.openchamberConsultReceipt).toMatchObject({ degraded: true });
    expect(harness.state.phaseLog).toContain('run-1:finish:done');
  });

  test('a failed dispatch request keeps the server-owned lease and marks the run failed', async () => {
    const harness = createHarness();
    harness.state.dispatchConsultFailure = new Error('prompt rejected');
    const handle = harness.submit(baseInput());
    await harness.flush();

    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(errorOf(result)).toContain('prompt rejected');
    // REQ-2: a thrown dispatch request is ambiguous, so the release stays
    // server-owned (the lease protects the possibly-running send) and the
    // item + claim remain queued.
    expect(result.uncertain).toBe(true);
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });
});

describe('cancellation and failures', () => {
  test('cancel before admission removes the queued item and never dispatches', async () => {
    const harness = createHarness();
    harness.state.status = 'busy';

    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.claims).toBe(0);

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
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.phaseLog).toContain('run-1:finish:cancelled');
  });

  test('cancel after the claim removes the consult item and never dispatches', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.startInputs).toHaveLength(1);
    expect(harness.state.claims).toBe(1);

    handle.cancel();
    handle.cancel();
    await harness.flush();
    expect(harness.state.runtimeCancels).toEqual(['run-1']);

    // The real runtime resolves a cancelled result; the fake mirrors it.
    harness.lastConsultation().resolve(consultationResult({ status: 'cancelled', blocks: [] }));
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    // The claimed item is removed so it can never be dispatched or revert to
    // a normal send; the hold is released (the caller restores the composer).
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a degraded consultation after a real start still dispatches alone', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.claims).toBe(1);

    // Degraded = all advisors failed after a real start; the consult message
    // still dispatches, carrying only the explicit degraded notice.
    harness.lastConsultation().resolve(consultationResult({
      status: 'degraded',
      blocks: [],
      advisors: [provenance({ status: 'failed', reason: 'boom' })],
    }));
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    expect(harness.state.dispatchConsultCalls).toBe(1);
    expect(harness.state.payloadCalls).toHaveLength(1);
    const metadata = harness.state.payloadCalls[0].textPartMetadata as { openchamberConsultReceipt?: { degraded?: boolean } };
    expect(metadata.openchamberConsultReceipt?.degraded).toBe(true);
    expect(harness.state.queueItems).toEqual([]);
  });

  test('a busy outcome retries the dispatch until it succeeds', async () => {
    const harness = createHarness();
    harness.state.dispatchConsultBusy = true;
    const handle = harness.submit(baseInput());
    await harness.flush();
    let settled = false;
    void handle.result.then(() => { settled = true; });

    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    // Still retrying: busy is not terminal.
    expect(harness.state.dispatchConsultCalls).toBeGreaterThanOrEqual(1);
    expect(settled).toBe(false);
    harness.state.dispatchConsultBusy = false;
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    expect(harness.state.dispatchConsultCalls).toBeGreaterThanOrEqual(2);
    expect(harness.state.queueItems).toEqual([]);
  });

  test('cancel during the busy retry wait reaches terminal: item removed, hold released', async () => {
    const harness = createHarness();
    harness.state.dispatchConsultBusy = true;
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    let settled = false;
    void handle.result.then(() => { settled = true; });
    expect(settled).toBe(false);

    handle.cancel();
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
    expect(harness.state.holds.at(-1)).toBe(false);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('cancel during an in-flight dispatch that then dispatches reports dispatched', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    let resolveGate: (outcome: ConsultDispatchOutcome) => void = () => undefined;
    harness.state.dispatchConsultGate = {
      promise: new Promise<ConsultDispatchOutcome>((resolve) => {
        resolveGate = resolve;
      }),
    };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    // The request is in flight: the cancel is recorded, not applied.
    handle.cancel();
    expect(harness.state.runtimeCancels).toEqual([]);
    resolveGate({ status: 'dispatched' });
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    // The server released the hold; the submission never issued its own.
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('a lost claim is re-established with a fresh payload and the dispatch retried', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    const claimsBefore = harness.state.claims;
    harness.state.dispatchConsultOutcome = { status: 'claim-lost' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('dispatched');
    // Re-claim + payload re-set + retry.
    expect(harness.state.claims).toBe(claimsBefore + 1);
    expect(harness.state.payloadCalls).toHaveLength(2);
    expect(harness.state.dispatchConsultCalls).toBe(2);
    expect(harness.state.queueItems).toEqual([]);
  });

  test('a terminal re-claim refusal after claim-lost reconciles: the item stays queued and the outcome is decided by resolve', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'claim-lost' };
    harness.state.claimFailure = new Error('cannot claim queued message: not-consult');
    // The reconcile resolve answers unknown: the delivery stays undecided.
    harness.state.resolveConsultOutcome = { status: 'unresolved' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    // The re-claim refusal is not a proof of non-delivery: the run reconciles
    // first, and only the resolve can decide. Nothing is removed here.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.resolveConsultCalls).toEqual([{ sessionId: 'parent', messageId: 'q-1' }]);
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    // The lease stays server-owned, like every other uncertain path.
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('a not-consult re-claim refusal with a resolve not-found answer settles delivered-raw without removal', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'claim-lost' };
    harness.state.claimFailure = new Error('cannot claim queued message: not-consult');
    harness.state.resolveConsultOutcome = { status: 'not-found' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    // The item left the queue without this run dispatching it: the
    // established item-gone convention, no client removal.
    expect(result.status).toBe('delivered-raw');
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.resolveConsultCalls).toHaveLength(1);
  });

  test('reclaim exhaustion reconciles: the never-attempted answer keeps the item recoverable and sends nothing', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    // Every dispatch loses the claim to a racing foreign owner who also
    // leaves a witness on the item; the first three re-claims succeed, so
    // the 4th answer is the exhaustion edge.
    harness.state.dispatchConsultClaimLost = true;
    harness.state.foreignClaimOwner = 'consult:foreign';
    harness.state.foreignClaimWitness = true;
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    const item = harness.state.queueItems[0];
    // Exhaustion is not a proof of non-delivery: the reconcile round trip
    // answered never-attempted, so the item stays queued (recoverable
    // server-side), uncertain, with no client removal and no composer
    // restore — and exactly one resolve.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.error).toContain('never dispatched');
    expect(result.error).toContain('recoverable');
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.dispatchConsultCalls).toBe(4);
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    // The foreign claim and witness the harness modeled survive untouched.
    expect(item.claimed).toEqual({ owner: 'consult:foreign', claimedAt: harness.state.now });
    expect(item.consult?.textPartMetadata).toEqual({ openchamberConsultReceipt: { runID: 'foreign-run' } });
    expect(harness.state.dispatchConsultCalls).toBe(4);
    expect(harness.state.resolveConsultCalls).toEqual([{ sessionId: 'parent', messageId: 'q-1' }]);
    // The lease stays server-owned: the harness resolve never removes the
    // item, so the foreign reservation it models survives.
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('reclaim exhaustion with a delivered reconcile reports the neutral delivered result with dispatch provenance', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultClaimLost = true;
    harness.state.resolveConsultOutcome = { status: 'dispatched', delivered: 'confirmed' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    // The turn landed through another dispatch: the neutral delivered result
    // with provenance, no client removal (resolve removed it server-side;
    // the harness resolve does not mutate), and no extra dispatch calls.
    expect(result).toEqual({ status: 'delivered', runId: 'run-1', resolvedDelivered: true, via: 'dispatch', queueItemRestored: false });
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.dispatchConsultCalls).toBe(4);
    expect(harness.state.resolveConsultCalls).toEqual([{ sessionId: 'parent', messageId: 'q-1' }]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('reclaim exhaustion with a failing reconcile stays uncertain and removes nothing', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultClaimLost = true;
    harness.state.resolveConsultFailure = new Error('resolve request failed');
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    // The resolve could not be read, so it proved nothing: fail closed.
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(errorOf(result)).toContain('could not be read');
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.dispatchConsultCalls).toBe(4);
    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('an already-claimed re-claim failure reconciles: an unresolved answer keeps the item', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'claim-lost' };
    harness.state.claimFailure = new Error('cannot claim queued message: already-claimed');
    harness.state.resolveConsultOutcome = { status: 'unresolved' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, true]);
  });

  test('an attempt-recorded re-claim refusal after claim-lost is uncertain: the item stays queued and reserved', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    // The dispatch lost its claim, and the re-claim then hits a witness that
    // appeared meanwhile: an attempt may already exist, so the delivery is
    // undecided and nothing may be cleaned up or re-sent.
    harness.state.dispatchConsultOutcome = { status: 'claim-lost' };
    harness.state.claimFailure = new Error('cannot claim queued message: attempt-recorded');
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.queueItemRestored).toBe(false);
    expect(result.error).toContain('dispatch attempt already exists');
    // The item is NOT removed and the composer must not restore: the
    // reservation stays server-side for a later reconcile.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    // The lease stays server-owned, like the other uncertain paths.
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('an attempt-recorded initial claim is uncertain: own hold released, item stays queued', async () => {
    const harness = createHarness();
    // Admission passes, then a witness appeared before this run's claim (a
    // concurrent dispatch): the server refuses with attempt-recorded.
    const handle = harness.submit(baseInput());
    harness.state.claimFailure = new Error('cannot claim queued message: attempt-recorded');
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.queueItemRestored).toBe(false);
    expect(result.error).toContain('dispatch attempt already exists');
    // No removal and no restore: the item stays queued for a resolve.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-1']);
    expect(harness.state.events).not.toContain('queue:remove:q-1');
    // This run's own hold was released exactly once (owner-scoped, so the
    // item's live claimant keeps its own reservation).
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('a definite send failure removes the item and restores the composer contract', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'send-failed', delivered: 'no' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBeUndefined();
    expect(result.queueItemRestored).toBe(false);
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('an indeterminate send failure keeps the item and flags the result uncertain', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'send-failed', delivered: 'unknown' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.queueItemRestored).toBe(false);
    // REQ-2: the server-owned lease keeps the hold; the submission must NOT
    // release it (the proxy prompt gate depends on it) and stops only the
    // heartbeat. The item + claim stay.
    expect(harness.state.queueItems).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
    await harness.tickHeartbeat();
    expect(harness.state.holds).toEqual([true, true]);
  });

  test('an unexpected error reaching the outer catch releases the hold and stays terminal', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    // Force a pre-dispatch failure whose terminal bookkeeping call then
    // throws once; the submission's outer catch must still finish the run and
    // release its own hold (the dispatch never started).
    harness.state.payloadFailure = new Error('payload exploded');
    harness.state.finishFailureOnce = new Error('run store exploded');
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(errorOf(result)).toContain('run store exploded');
    expect(result.uncertain).toBeUndefined();
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a thrown dispatch error is uncertain and never restores the capture', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultFailure = new Error('relay dropped the response');
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(errorOf(result)).toContain('relay dropped the response');
    expect(harness.state.queueItems).toHaveLength(1);
    // The lease stays server-owned; nothing releases after the uncertain path.
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('an attempt-present outcome settles uncertain: the item stays reserved and is never re-sent', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'attempt-present' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(errorOf(result)).toContain('dispatch attempt already exists');
    expect(result.queueItemRestored).toBe(false);
    // No re-dispatch: the server would refuse it anyway, so the submission
    // must not loop. Item + claim + hold stay server-side.
    expect(harness.state.dispatchConsultCalls).toBe(1);
    expect(harness.state.queueItems).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('an attempt-write-failed outcome settles uncertain with the honest nothing-was-sent message, hold kept', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'attempt-write-failed' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(errorOf(result)).toContain('could not record the dispatch attempt');
    expect(result.queueItemRestored).toBe(false);
    // Fail-closed on the server: no request was issued, and the live claim's
    // lease owns the hold (the submission never releases it here).
    expect(harness.state.dispatchConsultCalls).toBe(1);
    expect(harness.state.queueItems).toHaveLength(1);
    expect(harness.state.holds).toEqual([true, true]);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('a not-found outcome is a definite failure', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    harness.state.dispatchConsultOutcome = { status: 'not-found' };
    harness.lastConsultation().resolve(consultationResult());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBeUndefined();
    expect(harness.state.queueItems).toEqual([]);
  });

  test('onAdvisor events update the run store rows (F5)', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.claims).toBe(1);

    // The fake runtime's startConsultation does not emit onAdvisor itself;
    // the wiring under test is the mapping, so drive it directly.
    const consultation = harness.lastConsultation();
    const onAdvisor = harness.state.startInputs[0].onAdvisor;
    expect(onAdvisor).toBeDefined();
    onAdvisor?.({ index: 0, phase: 'started' });
    onAdvisor?.({ index: 0, phase: 'settled', status: 'ok', durationMs: 12 });
    onAdvisor?.({ index: 1, phase: 'started' });
    onAdvisor?.({ index: 1, phase: 'settled', status: 'failed', reason: 'boom' });

    consultation.resolve(consultationResult());
    const result = await handle.result;
    expect(result.status).toBe('dispatched');
    expect(harness.state.advisorUpdates).toEqual([
      { runId: 'run-1', index: 0, status: 'running' },
      { runId: 'run-1', index: 0, status: 'ok', durationMs: 12 },
      { runId: 'run-1', index: 1, status: 'running' },
      { runId: 'run-1', index: 1, status: 'failed', reason: 'boom' },
    ]);
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
    expect(harness.state.claims).toBe(0);
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
    expect(harness.state.claims).toBe(1);

    harness.state.runtimeKey = 'runtime-2';
    harness.lastConsultation().resolve(consultationResult());
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('runtime changed');
    expect(harness.state.holds).toEqual([true, true]);
  });

  test('a non-degraded consultation failure after the claim removes the item and releases the hold', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    expect(harness.state.claims).toBe(1);

    // A consultation error that is neither a refusal nor a cancel: the run
    // failed, the consult item is removed (never delivered as a normal send),
    // and the hold is released.
    harness.lastConsultation().reject(new Error('advisor transport collapsed'));
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('advisor transport collapsed');
    expect(result).toMatchObject({ queueItemRestored: false });
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
    expect(harness.state.holds).toEqual([true, true, false]);
    expect(harness.state.phaseLog).toContain('run-1:finish:failed');
  });

  test('a start refusal removes the claimed consult item and releases the hold', async () => {
    const harness = createHarness();
    const handle = harness.submit(baseInput());
    await harness.flush();
    // The item was claimed, not taken: it stays in the projection, marked.
    expect(harness.state.queueItems).toHaveLength(1);
    expect(harness.state.queueItems[0].claimed).toMatchObject({ owner: 'consult:run-1' });

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
    // The consult item was claimed, so refusal removes it instead of
    // re-queueing it; the caller restores the composer.
    expect(result.queueItemRestored).toBe(false);

    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.events).toContain('queue:remove:q-1');
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
    // The claimed message is removed, never restored for normal delivery.
    expect(harness.state.queueItems).toEqual([]);
    expect(harness.state.holds).toEqual([true, true, false]);
  });

  test('a failed take leaves the item queued and releases the hold', async () => {
    const harness = createHarness();
    harness.state.claimFailure = new Error('claim request failed');
    const handle = harness.submit(baseInput());
    await harness.flush();
    const result = await handle.result;

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('claim request failed');
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
    expect(harness.state.claims).toBe(0);
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
  });
});

// ---------------------------------------------------------------------------
// Resume (issue #3743): re-claiming a stranded (recoverable) consult item
// ---------------------------------------------------------------------------

describe('resume of a stranded consult item', () => {
  const resumeTarget = (): MessageQueueTarget =>
    createMessageQueueTarget('parent', '/work', 'runtime-1') ?? (() => { throw new Error('target fixture failed'); })();

  const strandedItem = (overrides?: Partial<QueuedMessage>): QueuedMessage => ({
    id: 'q-stranded',
    content: 'What should we do next? @build',
    text: 'What should we do next?',
    agentMention: 'build',
    createdAt: 500,
    kind: 'consult',
    recoverable: true,
    attachments: [attachment()],
    context: [contextPart()],
    sendConfig: { providerID: 'anthropic', modelID: 'claude-sonnet', agent: 'build', variant: 'high' },
    ...overrides,
  });

  const resumeOptions = () => ({
    advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build', variant: 'high' }],
    mode: 'parallel' as const,
    timeoutMs: 120_000,
  });

  test('claims the existing item and runs the fan-out from its own content, never enqueueing', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    // The consultation settles as soon as the fan-out starts (resume is one
    // awaited flow, so the gate must resolve mid-await).
    harness.state.consultations = [];
    const pending = harness.resume(resumeTarget(), item, resumeOptions()).then((outcome) => {
      return { outcome, startInputs: harness.state.startInputs };
    });
    await harness.flush();
    expect(harness.state.startInputs).toHaveLength(1);
    harness.lastConsultation().resolve(consultationResult());
    const result = (await pending).outcome;

    // The claim targeted the stranded item with the fresh run's owner.
    expect(harness.state.events).toContain('queue:claim:q-stranded:consult:run-1');
    // Resume never enqueues: the item is the only consult input the queue saw.
    expect(harness.state.queued).toEqual([]);
    // The fresh fan-out reads the item's own content, not the composer's.
    expect(harness.state.startInputs).toHaveLength(1);
    expect(harness.state.startInputs[0]).toMatchObject({
      parentSessionId: 'parent',
      directory: '/work',
      expectedRuntimeKey: 'runtime-1',
      messageText: 'What should we do next?',
      runId: 'run-1',
      mode: 'parallel',
      timeoutMs: 120_000,
    });
    // Advisors receive the item's attachments in the advisor input shape.
    expect(harness.state.startInputs[0].attachments).toEqual([
      { type: 'file', mime: 'image/png', url: 'data:image/png;base64,cG5n', filename: 'shot.png' },
    ]);
    // Dispatch happens through the consult route and settles dispatched.
    expect(harness.state.dispatchConsultCalls).toBe(1);
    expect(result.status).toBe('dispatched');
    expect(result).toMatchObject({ runId: 'run-1' });
    // The receipt is fresh: the payload merge rides the new run's owner.
    expect(harness.state.payloadCalls).toHaveLength(1);
    expect(harness.state.events).toContain('queue:payload:q-stranded');
  });

  test('capability refusal happens before anything is claimed or held', async () => {
    const harness = createHarness();
    harness.state.capabilityRefusal = { available: false, reason: 'protocol-missing' };
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('refused');
    if (result.status !== 'refused') throw new Error('expected a refusal');
    expect(result.code).toBe('capability-unavailable');
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    // The stranded item is untouched: the user can still remove it manually.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
  });

  test('an item claimed by another owner is refused without touching it', async () => {
    const harness = createHarness();
    const item = strandedItem({ claimed: { owner: 'consult:other-run', claimedAt: 1 } });
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('reserved by another owner');
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
  });

  test('an item that vanished from the queue refuses with nothing to resume', async () => {
    const harness = createHarness();
    const item = strandedItem({ id: 'q-gone' });
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('no longer in the queue');
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
  });

  test('a claim lost mid-flow fails without dispatching', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    harness.state.claimFailure = new Error('claim request failed');
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('claim request failed');
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    // The hold was acquired before the claim, so the failed claim releases it.
    expect(harness.state.holds).toEqual([true, false]);
  });

  test('a claim refused with attempt-recorded is terminal: refused once, never re-polled', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    // The strict resolve gate passed, then a witness appeared before the
    // claim (a concurrent dispatch): the server refuses with attempt-recorded.
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    harness.state.claimRefusal = new Error('cannot claim queued message: attempt-recorded');
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    // Terminal, not retryable: exactly one claim attempt, no polling loop.
    expect(harness.state.claims).toBe(1);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.payloadCalls).toHaveLength(0);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(errorOf(result)).toContain('could not be confirmed');
    // The item stays queued exactly as it was: only a resolve or manual
    // removal can settle a witnessed item.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
  });

  test('a runtime switch during resume stops without touching the item', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    harness.state.runtimeKey = 'runtime-2';
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('runtime changed');
    expect(harness.state.claims).toBe(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    // The stranded item stays exactly as it was.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
    expect(harness.state.heartbeatActive).toBe(false);
  });

  test('a normal (non-consult) item is refused', async () => {
    const harness = createHarness();
    const item = strandedItem({ kind: undefined });
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    expect(errorOf(result)).toContain('not a consult item');
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
  });

  test('resolve confirms delivery: no claim, hold, fan-out, or dispatch, and a neutral delivered result', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'dispatched', delivered: 'confirmed' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    // The delivery-first resolve is the only queue call: a landed turn is
    // never claimed, fanned out, or dispatched a second time.
    expect(harness.state.resolveConsultCalls).toEqual([{ sessionId: 'parent', messageId: 'q-stranded' }]);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.payloadCalls).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    // Delivery is decided before the capability read: nothing is left to
    // verify when the acting turn already landed.
    expect(harness.state.capabilityChecks).toBe(0);
    expect(harness.state.heartbeatActive).toBe(false);
    // No run record is started or finished: there is nothing to consult.
    expect(harness.state.runs.size).toBe(0);
    // The server owns the exactly-once removal and its broadcast; the resume
    // leaves the projection untouched.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
    // A delivered result the caller can read as neutral, not as a failure.
    expect(result).toEqual({
      status: 'delivered',
      runId: 'run-1',
      resolvedDelivered: true,
      via: 'resume',
      queueItemRestored: false,
    });
  });

  test('an unresolved resolve refuses without resuming: no claim, no fan-out, no dispatch', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'unresolved', recoverable: true };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    // The previous delivery is undecided: resuming could send it twice, so
    // the strict gate refuses before the claim.
    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.payloadCalls).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.error).toContain('could not be confirmed');
    // The item stays exactly as it was, so a later Resume can re-check.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
  });

  test('a resumable resolve proves nothing was dispatched and resumes through claim, fan-out, dispatch', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    const pending = harness.resume(resumeTarget(), item, resumeOptions());
    await harness.flush();
    expect(harness.state.startInputs).toHaveLength(1);
    harness.lastConsultation().resolve(consultationResult());
    const outcome = await pending;

    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.events).toContain('queue:claim:q-stranded:consult:run-1');
    expect(harness.state.dispatchConsultCalls).toBe(1);
    expect(outcome.status).toBe('dispatched');
  });

  test('a resolve transport failure never resumes: no claim, no fan-out, no dispatch', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultFailure = new Error('resolve request failed');
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    // A resolve that could not be read proves nothing: the previous acting
    // turn may have landed, so nothing may be claimed, fanned out, or sent.
    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.payloadCalls).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.error).toContain('could not be confirmed');
    // The item stays exactly as it was, so a later Resume can re-check.
    expect(harness.state.queueItems.map((entry) => entry.id)).toEqual(['q-stranded']);
  });

  test('a sending resolve refuses without resuming: the in-flight dispatch owns the item', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'sending' };
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(harness.state.resolveConsultCalls).toHaveLength(1);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.holds).toEqual([]);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(result.uncertain).toBe(true);
    expect(result.error).toContain('could not be confirmed');
  });

  test('an unresolved resolve refuses now and a later resolve can still confirm delivery', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'unresolved' };

    const first = await harness.resume(resumeTarget(), item, resumeOptions());
    expect(first.status).toBe('failed');
    if (first.status !== 'failed') throw new Error('expected a failure');
    expect(first.uncertain).toBe(true);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);

    // The item is still queued and unclaimed: a later Resume re-checks and the
    // marker is now found, so it reports delivered without any dispatch.
    harness.state.resolveConsultOutcome = { status: 'dispatched', delivered: 'confirmed' };
    const second = await harness.resume(resumeTarget(), item, resumeOptions());
    expect(second).toEqual({
      status: 'delivered',
      runId: 'run-2',
      resolvedDelivered: true,
      via: 'resume',
      queueItemRestored: false,
    });
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
    expect(harness.state.payloadCalls).toHaveLength(0);
    expect(harness.state.dispatchConsultCalls).toBe(0);
    expect(harness.state.holds).toEqual([]);
  });

  test('an unexpected throw after the hold finishes the run terminal and releases the hold', async () => {
    const harness = createHarness();
    const item = strandedItem();
    harness.state.queueItems.push(item);
    harness.state.resolveConsultOutcome = { status: 'resumable' };
    // The run store blows up on the resume's first phase write, after the hold
    // was acquired: the outer safety must still finish the run and release the
    // hold, with no heartbeat left running.
    harness.state.setPhaseFailureOnce = new Error('run store exploded');
    const result = await harness.resume(resumeTarget(), item, resumeOptions());

    expect(result.status).toBe('failed');
    if (result.status !== 'failed') throw new Error('expected a failure');
    expect(errorOf(result)).toContain('run store exploded');
    expect(harness.state.runs.get('parent')?.phase).toBe('failed');
    expect(harness.state.holds).toEqual([true, false]);
    expect(harness.state.heartbeatActive).toBe(false);
    expect(harness.state.claims).toBe(0);
    expect(harness.state.startInputs).toHaveLength(0);
  });
});
