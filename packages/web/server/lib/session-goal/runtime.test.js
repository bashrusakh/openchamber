import fs from 'fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Deterministic scratch data dir for file-backed objective tests.
process.env.OPENCHAMBER_DATA_DIR = '/tmp/opencode/session-goal-test-data-3279';
const SCRATCH_DATA_DIR = process.env.OPENCHAMBER_DATA_DIR;

import { createSessionGoalRuntime } from './runtime.js';

// Deterministic objective reads without filesystem I/O under fake timers: the
// runtime accepts readObjectiveImpl as a dependency; tests provide a faithful
// implementation (missing file -> null).
const FAITHFUL_READ_OBJECTIVE = async () => null;

const SESSION_ID = 'ses_parent';
const CHILD_ID = 'ses_child';
const DIRECTORY = '/workspace';

const goal = {
  id: 'goal_1',
  objective: 'Finish the task',
  status: 'active',
  turnsUsed: 1,
  createdAt: 1,
  updatedAt: 1,
};

const session = {
  id: SESSION_ID,
  directory: DIRECTORY,
  metadata: { openchamber: { goal } },
};

const jsonResponse = (body, status = 200) => {
  if (status === 204) {
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
};

const requestPath = (input) => new URL(input.url || input).pathname;

const assistantMessage = (id, infoOverrides = {}) => ({
  info: {
    id,
    sessionID: SESSION_ID,
    role: 'assistant',
    providerID: 'provider',
    modelID: 'model',
    time: { created: 2, completed: 2 },
    tokens: { input: 1, output: 1, cache: { read: 0 } },
    ...infoOverrides,
  },
  parts: [{ type: 'text', text: 'The agent made progress.' }],
});

const userMessage = (id, created = 5) => ({
  info: {
    id,
    sessionID: SESSION_ID,
    role: 'user',
    time: { created },
  },
  parts: [{ type: 'text', text: 'New user instruction.' }],
});

// A session-goal runtime harness that keeps a mutable session model so tests
// can simulate user actions (pause/clear/edit/replacement/new messages)
// between the steps of an inflight tick.
const createHarness = (options = {}) => {
  const requests = [];
  let messageFetchCount = 0;
  let promptFetchCount = 0;

  const failPaths = new Set(options.failPaths || []);
  const state = {
    goal: { ...goal, ...(options.goalOverrides || {}) },
    messages: options.messages || [],
    statuses: options.statuses || {},
    children: options.children || [],
    prompt: { status: options.promptStatus || 204 },
    promptByAttempt: options.promptByAttempt || [],
    unrelatedMetadata: options.unrelatedMetadata || {},
    metadata: options.metadata || null,
  };

  const service = {
    generateSmallModelText: vi.fn(async () => ({
      text: `{"verdict":"${options.auditVerdict || 'continue'}","note":"More work remains"}`,
      providerID: 'provider',
      modelID: 'model',
    })),
  };

  const setSessionGoal = (nextGoal) => {
    state.goal = nextGoal;
  };

  const setMessages = (messages) => {
    state.messages = messages;
  };

  const setStatuses = (statuses) => {
    state.statuses = statuses;
  };

  const setPrompt = (promptByAttempt) => {
    state.promptByAttempt = promptByAttempt;
  };

  const patchGoalOnServer = (mutate) => {
    state.goal = mutate(state.goal);
  };

  const fetchImpl = vi.fn(async (input, init = {}) => {
    const pathname = requestPath(input);
    const method = init.method ?? 'GET';
    requests.push({ pathname, method, body: init.body });
    if (failPaths.has(pathname) && method === 'GET') {
      return jsonResponse({ error: 'unavailable' }, 503);
    }
    if (pathname === `/session/${SESSION_ID}` && method === 'PATCH') {
      const patched = JSON.parse(init.body);
      const nextGoal = patched.metadata.openchamber.goal;
      state.goal = nextGoal;
      return jsonResponse({ ...session, metadata: { openchamber: { goal: nextGoal } } });
    }
    if (pathname === `/session/${SESSION_ID}`) return jsonResponse({
      ...session,
      metadata: state.metadata || { openchamber: { ...state.unrelatedMetadata, goal: state.goal } },
    });
    if (pathname === '/session/status') return jsonResponse(state.statuses);
    if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse(state.children);
    if (pathname === `/session/${SESSION_ID}/message`) {
      const index = Math.min(messageFetchCount, (options.messageFetches ? options.messageFetches.length : 0) - 1);
      const messages = options.messageFetches ? options.messageFetches[index] : state.messages;
      messageFetchCount += 1;
      return jsonResponse(messages);
    }
    if (pathname === `/session/${SESSION_ID}/prompt_async`) {
      const outcome = state.promptByAttempt.length > 0
        ? (state.promptByAttempt[promptFetchCount] ?? state.promptByAttempt[state.promptByAttempt.length - 1])
        : state.prompt;
      promptFetchCount += 1;
      if (outcome?.error) {
        throw outcome.error;
      }
      return jsonResponse({ ok: true }, outcome?.status ?? 204);
    }
    throw new Error(`Unexpected request: ${pathname}`);
  });

  vi.stubGlobal('fetch', fetchImpl);

  const runtime = createSessionGoalRuntime({
    buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
    getOpenCodeAuthHeaders: () => ({}),
    getSmallModelService: async () => service,
    isEnabled: () => true,
    idleQuietMs: 10,
    kickoffQuietMs: 10,
    readObjectiveImpl: options.readObjectiveImpl ?? FAITHFUL_READ_OBJECTIVE,
    ...(options.runtimeOverrides || {}),
  });

  return {
    runtime,
    requests,
    service,
    state,
    setSessionGoal,
    setMessages,
    setStatuses,
    setPrompt,
    patchGoalOnServer,
    get messageFetchCount() {
      return messageFetchCount;
    },
    get promptFetchCount() {
      return promptFetchCount;
    },
  };
};


const stepTimers = async (steps = 12, perStep = 60) => {
  for (let i = 0; i < steps; i += 1) {
    await vi.advanceTimersByTimeAsync(perStep);
  }
};
const runIdleTick = async (runtime) => {
  runtime.processPayload({
    type: 'session.status',
    properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
  });
  await vi.runOnlyPendingTimersAsync();
};

const lastPatchedGoal = (requests) => {
  const patches = requests.filter((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH');
  expect(patches.length).toBeGreaterThan(0);
  return JSON.parse(patches.at(-1).body).metadata.openchamber.goal;
};

const goalPatches = (requests) => requests
  .filter((request) => request.pathname === `/session/${SESSION_ID}` && request.method === 'PATCH')
  .map((request) => JSON.parse(request.body).metadata.openchamber.goal);

const promptCalls = (requests) => requests
  .filter((request) => request.pathname === `/session/${SESSION_ID}/prompt_async` && request.method === 'POST');

describe('session goal live activity gate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('waits for the next parent idle when the parent resumed during the quiet window', async () => {
    const paths = [];
    const getSmallModelService = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [SESSION_ID]: { type: 'busy' } });
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(paths).toEqual([`/session/${SESSION_ID}`, '/session/status']);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(2);
    runtime.stop();
  });

  it('waits for the parent result cycle while a direct child is working', async () => {
    const paths = [];
    const getSmallModelService = vi.fn();
    vi.stubGlobal('fetch', vi.fn(async (input) => {
      const pathname = requestPath(input);
      paths.push(pathname);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse(session);
      if (pathname === '/session/status') return jsonResponse({ [CHILD_ID]: { type: 'busy' } });
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([{ id: CHILD_ID, parentID: SESSION_ID }]);
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService,
      isEnabled: () => true,
      idleQuietMs: 10,
    });
    runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    expect(paths).toEqual([
      `/session/${SESSION_ID}`,
      '/session/status',
      `/session/${SESSION_ID}/children`,
    ]);
    expect(getSmallModelService).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(paths).toHaveLength(3);
    runtime.stop();
  });

  it('audits normally when the idle parent has no working children', async () => {
    const harness = createHarness({
      auditVerdict: 'complete',
      messages: [assistantMessage('msg_assistant', { time: { created: 2, completed: 2 } })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).toHaveBeenCalledOnce();
    expect(lastPatchedGoal(harness.requests)).toMatchObject({
      status: 'complete',
      evaluationProviderID: 'provider',
      evaluationModelID: 'model',
    });
    harness.runtime.stop();
  });

  it('skips audit and sends continuation prompt when assistant message finishes with length stop', async () => {
    const harness = createHarness({
      messages: [assistantMessage('msg_assistant_len', {
        finish: 'length',
        time: { created: 2, completed: 2 },
        tokens: { input: 100, output: 4096, reasoning: 4096, cache: { read: 0 } },
      })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(lastPatchedGoal(harness.requests)).toMatchObject({ status: 'active', turnsUsed: 2 });
    expect(promptCalls(harness.requests)).toHaveLength(1);
    harness.runtime.stop();
  });

  it('skips audit and sends continuation prompt when assistant message carries MessageOutputLengthError', async () => {
    const harness = createHarness({
      messages: [assistantMessage('msg_assistant_len_err', {
        error: { name: 'MessageOutputLengthError', message: 'Maximum token limit reached' },
        time: { created: 2, completed: 2 },
      })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(lastPatchedGoal(harness.requests)).toMatchObject({ status: 'active', turnsUsed: 2 });
    expect(promptCalls(harness.requests)).toHaveLength(1);
    harness.runtime.stop();
  });

  it.each([
    { name: 'APIError', error: { name: 'APIError', message: 'provider failed' } },
    { name: 'StructuredOutputError', error: { name: 'StructuredOutputError', message: 'invalid output' } },
    { name: 'unnamed errors', error: {} },
  ])('blocks a length finish when the assistant also has a non-length $name', async ({ error }) => {
    const harness = createHarness({
      messages: [assistantMessage('msg_assistant_error', { finish: 'length', error })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(0);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({
      status: 'blocked',
      statusReason: error.name || 'assistant turn failed',
    });
    harness.runtime.stop();
  });

  it('blocks after two consecutive length-truncated agent turns without persisting a counter, regardless of message IDs', async () => {
    const firstLength = assistantMessage('z', { finish: 'length', time: { created: 10, completed: 11 } });
    const summary = assistantMessage('summary', { summary: true, time: { created: 15, completed: 16 } });
    const secondLength = assistantMessage('a', { finish: 'length', time: { created: 20, completed: 21 } });
    const harness = createHarness({
      messages: [firstLength],
    });
    await runIdleTick(harness.runtime);
    harness.setMessages([firstLength, summary, secondLength]);
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(1);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({
      status: 'blocked',
      statusReason: 'repeated output truncation',
    });
    harness.runtime.stop();
  });

  it('continues after a truncated agent turn followed by a length-finished summary', async () => {
    const firstLength = assistantMessage('agent-length', { finish: 'length', time: { created: 10, completed: 11 } });
    const summary = assistantMessage('summary', { summary: true, finish: 'length', time: { created: 15, completed: 16 } });
    const harness = createHarness({
      messages: [firstLength],
    });
    await runIdleTick(harness.runtime);
    harness.setMessages([firstLength, summary]);
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(2);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({ status: 'active' });
    harness.runtime.stop();
  });

  it('allows length recovery after an ordinary assistant turn breaks the streak', async () => {
    const firstLength = assistantMessage('msg_length_before_normal', { finish: 'length', time: { created: 10, completed: 11 } });
    const normal = assistantMessage('msg_normal', { time: { created: 12, completed: 13 } });
    const secondLength = assistantMessage('msg_length_after_normal', { finish: 'length', time: { created: 20, completed: 21 } });
    const harness = createHarness({
      messages: [firstLength],
    });
    await runIdleTick(harness.runtime);
    harness.setMessages([firstLength, normal, secondLength]);
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(2);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({ status: 'active' });
    harness.runtime.stop();
  });

  it('keeps MessageAbortedError pause behavior instead of continuing', async () => {
    const harness = createHarness({
      messages: [assistantMessage('msg_aborted', { error: { name: 'MessageAbortedError' } })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(0);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({
      status: 'paused',
      statusReason: 'paused after abort',
    });
    harness.runtime.stop();
  });

  it('checks the token budget before allowing length recovery', async () => {
    const harness = createHarness({
      goalOverrides: { tokenBudget: 5 },
      messages: [assistantMessage('msg_budget_length', {
        finish: 'length',
        time: { created: 2, completed: 3 },
        tokens: { input: 3, output: 3, cache: { read: 0 } },
      })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(0);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({ status: 'budgetLimited' });
    harness.runtime.stop();
  });

  it('checks the auto-continuation cap before allowing length recovery', async () => {
    const harness = createHarness({
      runtimeOverrides: { maxAutoTurns: 1 },
      messages: [assistantMessage('msg_cap_length', { finish: 'length', time: { created: 2, completed: 3 } })],
    });
    await runIdleTick(harness.runtime);

    expect(harness.service.generateSmallModelText).not.toHaveBeenCalled();
    expect(promptCalls(harness.requests)).toHaveLength(0);
    expect(lastPatchedGoal(harness.requests)).toMatchObject({
      status: 'blocked',
      statusReason: 'auto-continuation limit reached',
    });
    harness.runtime.stop();
  });
});

describe('session goal lifecycle hardening (#3279)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    try {
      fs.rmSync(`${SCRATCH_DATA_DIR}/goals`, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  });

  // Build a harness whose audit promise is resolved manually, so tests can
  // mutate the authoritative session state BETWEEN the audit and the
  // reservation/dispatch steps of an inflight tick.
  const createDeferredHarness = (options = {}) => {
    const requests = [];
    let messageFetchCount = 0;
    let promptFetchCount = 0;
    let auditResolve = null;

    const state = {
      goal: { ...goal, ...(options.goalOverrides || {}) },
      messages: options.messages || [],
      statuses: options.statuses || {},
      promptByAttempt: options.promptByAttempt || [],
      metadata: options.metadata || null,
    };

    const fetchImpl = vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      const method = init.method ?? 'GET';
      requests.push({ pathname, method, body: init.body });
      if (pathname === `/session/${SESSION_ID}` && method === 'PATCH') {
        const patched = JSON.parse(init.body).metadata.openchamber.goal;
        state.goal = { ...state.goal, ...patched, updatedAt: Date.now() };
        return jsonResponse({ ...session, metadata: { openchamber: { goal: state.goal } } });
      }
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({
        ...session,
        metadata: state.metadata || { openchamber: { goal: state.goal } },
      });
      if (pathname === '/session/status') return jsonResponse(state.statuses);
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        const messages = options.messageFetches ? options.messageFetches[Math.min(messageFetchCount, options.messageFetches.length - 1)] : state.messages;
        messageFetchCount += 1;
        return jsonResponse(messages);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) {
        const outcome = state.promptByAttempt[Math.min(promptFetchCount, state.promptByAttempt.length - 1)];
        promptFetchCount += 1;
        if (outcome?.error) throw outcome.error;
        return jsonResponse({}, outcome?.status ?? 204);
      }
      throw new Error(`Unexpected request: ${pathname}`);
    });

    vi.stubGlobal('fetch', fetchImpl);

    const auditPromise = new Promise((resolve) => {
      auditResolve = resolve;
    });
    const service = {
      generateSmallModelText: vi.fn(() => auditPromise),
    };

    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => service,
      isEnabled: () => true,
      idleQuietMs: 10,
      kickoffQuietMs: 10,
      readObjectiveImpl: options.readObjectiveImpl ?? FAITHFUL_READ_OBJECTIVE,
      ...(options.runtimeOverrides || {}),
    });

    return {
      runtime,
      requests,
      service,
      state,
      resolveAudit: (verdict = 'continue') => auditResolve({
        text: `{"verdict":"${verdict}","note":"n"}`,
        providerID: 'provider',
        modelID: 'model',
      }),
      setGoal: (next) => {
        state.goal = next;
        if (next === null && state.metadata) {
          delete state.metadata.openchamber.goal;
        }
      },
      setStatuses: (next) => { state.statuses = next; },
      setMessages: (next) => { state.messages = next; },
      setPrompt: (byAttempt) => { state.promptByAttempt = byAttempt; },
      get messageFetchCount() { return messageFetchCount; },
      get promptFetchCount() { return promptFetchCount; },
    };
  };

  const patchesOf = (requests) => requests
    .filter((r) => r.pathname === `/session/${SESSION_ID}` && r.method === 'PATCH')
    .map((r) => JSON.parse(r.body).metadata.openchamber.goal);
  const lastPatch = (requests) => patchesOf(requests).at(-1);
  const promptsOf = (requests) => requests.filter((r) => r.pathname === `/session/${SESSION_ID}/prompt_async`);

  it('pauses immediately when an abort event lands while the audit is inflight, and never dispatches', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_plain', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // Let the tick reach the audit (audit call now pending).
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // The abort event lands with the SAME message id (no message-id movement):
    // the plain turn the audit is evaluating is aborted in place.
    h.runtime.processPayload({
      type: 'message.updated',
      properties: { info: {
        id: 'msg_plain',
        sessionID: SESSION_ID,
        role: 'assistant',
        error: { name: 'MessageAbortedError' },
      } },
    }, DIRECTORY);

    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(0);
    expect(lastPatch(h.requests)).toMatchObject({ status: 'paused', statusReason: 'paused after abort' });
    h.runtime.stop();
  });

  it('drops the continuation when the user pauses the goal while the audit is inflight', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // UI pause: status flips, updatedAt moves.
    h.setGoal({ ...goal, status: 'paused', statusReason: '', updatedAt: Date.now() + 10_000 });

    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(0);
    // The runtime must NOT have overwritten the user's pause with any write:
    // the stored goal remains exactly what the user set.
    expect(h.state.goal.status).toBe('paused');
    h.runtime.stop();
  });

  it('drops the continuation when the user clears the goal while the audit is inflight', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // UI clear: goal metadata removed entirely (no goal at all).
    h.setGoal(null);
    h.runtime.processPayload({
      type: 'session.updated',
      properties: { info: { id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: {} } } },
    }, DIRECTORY);

    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(0);
    h.runtime.stop();
  });

  it('drops the continuation when the user marks the goal complete while the audit is inflight', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    h.setGoal({ ...goal, status: 'complete', statusReason: 'marked by user', updatedAt: Date.now() + 10_000 });

    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(0);
    // User state survives untouched: no runtime write raced the completion.
    expect(h.state.goal.status).toBe('complete');
    h.runtime.stop();
  });

  it('drops the continuation when a new user message lands while the audit is inflight, and does not consume turnsUsed', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // A newer user message appears on the tail while we audit.
    h.setMessages([assistantMessage('msg_1', { time: { created: 2, completed: 2 } }), userMessage('msg_user_new', 100)]);
    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    // The reserved turn (if any) is CAS-rolled back: turnsUsed must stay 1.
    expect(promptsOf(h.requests)).toHaveLength(0);
    const goalAfter = lastPatch(h.requests);
    expect(goalAfter.turnsUsed).toBe(1);
    h.runtime.stop();
  });

  it('keeps the goal paused when a same-message abort mutation is re-emitted after dispatch was reserved', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();
    expect(promptsOf(h.requests)).toHaveLength(1);

    // Abort mutation on the SAME message id arrives after the continuation
    // was dispatched: the goal must pause, and no further continuation may go.
    h.runtime.processPayload({
      type: 'message.updated',
      properties: { info: {
        id: 'msg_1',
        sessionID: SESSION_ID,
        role: 'assistant',
        error: { name: 'MessageAbortedError' },
      } },
    }, DIRECTORY);
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(1);
    expect(lastPatch(h.requests)).toMatchObject({ status: 'paused', statusReason: 'paused after abort' });
    h.runtime.stop();
  });

  it('does not lose an idle event that arrives while a tick is inflight (one bounded follow-up)', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // New idle while the tick is still inflight — must not disappear.
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });

    // Finish the first tick; the follow-up tick runs exactly once (the armed
    // pending wakeup), never a cascade: message fetches = 2 per tick.
    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();
    await vi.runOnlyPendingTimersAsync();
    expect(h.messageFetchCount).toBe(4);
    expect(promptsOf(h.requests)).toHaveLength(2);
    h.runtime.stop();
  });

  it('replaces a pending normal idle timer with the short resume kickoff', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    // Arm a normal idle timer.
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // Resume arrives: must kick off with the short delay (10ms in the test
    // runtime), replacing the 15s idle timer.
    h.runtime.processPayload({
      type: 'session.updated',
      properties: { info: { id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: { ...goal, statusReason: 'resumed' } } } } },
    }, DIRECTORY);
    // The resume kickoff fires the tick immediately; the audit completes and
    // the continuation dispatches (resume replaced the long idle timer).
    await vi.runOnlyPendingTimersAsync();
    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests).length).toBeGreaterThan(0);
    h.runtime.stop();
  });

  it('retries boundedly and settles blocked when messages cannot be read', async () => {
    const h = createHarness({
      failPaths: [`/session/${SESSION_ID}/message`],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // Messages fetch fails every time; the runtime must retry with backoff
    // and then settle blocked instead of staying active forever.
    await vi.advanceTimersByTimeAsync(360_000);
    const finalGoal = lastPatch(h.requests);
    expect(finalGoal.status).toBe('blocked');
    expect(finalGoal.statusReason).toBe('messages unavailable');
    h.runtime.stop();
  });

  it('retries boundedly when the objective file is unreadable and settles blocked with no inline objective', async () => {
    const h = createHarness({
      goalOverrides: { objectiveFile: true, objective: '' },
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // readObjective is mocked to always fail: the runtime must retry with
    // backoff and then settle blocked explicitly — never strand active+idle.
    await stepTimers();
    const blockedPatch = patchesOf(h.requests).find((patch) => patch.status === 'blocked');
    expect(blockedPatch).toMatchObject({
      status: 'blocked',
      statusReason: 'objective unavailable',
    });
    h.runtime.stop();
  });

  it('never audits goal A against objective B when the goal is edited in place under the tick', async () => {
    const h = createDeferredHarness({
      goalOverrides: { objective: 'Original objective' },
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // Let the tick reach the audit (timing-tolerant: microtask scheduling can
    // vary when the suite runs with real-I/O neighbors).
    for (let i = 0; i < 20 && h.service.generateSmallModelText.mock.calls.length === 0; i += 1) {
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(h.service.generateSmallModelText).toHaveBeenCalled();

    // The goal is edited in place while the audit is inflight: the revision
    // key (objective text) changed, so any continuation of revision A must be
    // dropped — never dispatched with the new objective B.
    h.setGoal({ ...goal, objective: 'Edited objective B', updatedAt: Date.now() + 10_000 });
    h.resolveAudit('continue');
    await vi.runOnlyPendingTimersAsync();

    expect(promptsOf(h.requests)).toHaveLength(0);
    // The user's edit survives: the runtime wrote nothing over it.
    expect(h.state.goal.objective).toBe('Edited objective B');
    h.runtime.stop();
  });

  it('preserves unrelated metadata.openchamber.* keys on runtime patches', async () => {
    const h = createHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
      metadata: { openchamber: { someOtherFeature: { keep: 'me' }, goal: { ...goal } } },
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    // The runtime merges from a fresh read, so the unrelated key must be
    // part of every PATCH body.
    const bodies = h.requests.filter((r) => r.method === 'PATCH').map((r) => JSON.parse(r.body).metadata);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of bodies) {
      expect(body.openchamber.someOtherFeature).toEqual({ keep: 'me' });
    }
    h.runtime.stop();
  });

  it('does not re-dispatch when an ambiguous transport failure actually admitted the prompt (new turn appears)', async () => {
    const h = createHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
      // Fetch #1: the tick tail read. Fetch #2: the post-reservation tail
      // re-check (must still match, the continuation has not produced output
      // yet). Fetch #3: the reconciliation re-read AFTER the ambiguous POST —
      // it shows the new turn the admitted continuation produced.
      messageFetches: [
        [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
        [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
        [
          assistantMessage('msg_1', { time: { created: 2, completed: 2 } }),
          assistantMessage('msg_2_admitted', { time: { created: 3, completed: 4 } }),
        ],
      ],
    });
    h.setPrompt([{ error: new TypeError('network down') }]);
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await stepTimers();

    // Exactly ONE POST happened; the new assistant turn proved admission, so
    // the reserved turn stays counted and the goal remains active.
    expect(promptsOf(h.requests)).toHaveLength(1);
    expect(h.state.goal.status).toBe('active');
    expect(h.state.goal.turnsUsed).toBe(2);
    h.runtime.stop();
  });

  it('rolls the reserved turn back and re-dispatches boundedly after proven non-admission', async () => {
    const h = createHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.setPrompt([{ status: 400 }, { status: 204 }]);
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.runOnlyPendingTimersAsync();

    // First attempt proven non-admitted (400): turnsUsed rolled back, then a
    // fresh reservation and a successful dispatch — exactly ONE counting.
    expect(promptsOf(h.requests)).toHaveLength(2);
    const goalAfter = lastPatch(h.requests);
    expect(goalAfter.status).toBe('active');
    expect(goalAfter.turnsUsed).toBe(2);
    h.runtime.stop();
  });

  it('stops boundedly when ambiguous admission can never be established', async () => {
    const h = createHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
      runtimeOverrides: { maxDispatchAttempts: 2 },
    });
    h.setPrompt([{ error: new TypeError('timeout') }]);
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    // Every attempt is ambiguous; every reconciliation provably shows the
    // prompt never landed (idle + unchanged tail). Only proven non-admission
    // re-dispatches, boundedly; then the goal settles blocked explicitly.
    await stepTimers();
    expect(promptsOf(h.requests)).toHaveLength(2);
    expect(lastPatch(h.requests).status).toBe('blocked');
    h.runtime.stop();
  });

  it('keeps one effective tick per session and never runs concurrent audit/dispatch', async () => {
    const h = createDeferredHarness({
      messages: [assistantMessage('msg_1', { time: { created: 2, completed: 2 } })],
    });
    h.runtime.processPayload({
      type: 'session.status',
      properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
    });
    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.service.generateSmallModelText).toHaveBeenCalledOnce();

    // Many idle/Resume events while the audit is pending: they may only
    // produce ONE follow-up tick, not a burst.
    for (let i = 0; i < 5; i += 1) {
      h.runtime.processPayload({
        type: 'session.status',
        properties: { sessionID: SESSION_ID, status: { type: 'idle' }, directory: DIRECTORY },
      });
      h.runtime.processPayload({
        type: 'session.updated',
        properties: { info: { id: SESSION_ID, directory: DIRECTORY, metadata: { openchamber: { goal: { ...goal, statusReason: 'resumed' } } } } },
      }, DIRECTORY);
    }
    h.resolveAudit('continue');
    await stepTimers();
    // The burst coalesced into ONE follow-up tick; the Resume events made the
    // first (inflight) tick stale, so exactly ONE continuation is dispatched
    // for the whole burst — never 6.
    expect(promptsOf(h.requests)).toHaveLength(1);
    h.runtime.stop();
  });

  it('uses time.created chronology, never lexical message IDs (z → a rollover)', async () => {
    const harness = createHarness({
      messages: [
        assistantMessage('msg_zzzz', { time: { created: 10, completed: 11 }, error: { name: 'MessageAbortedError' } }),
        assistantMessage('msg_aaaa', { time: { created: 20, completed: 21 } }),
      ],
    });
    await runIdleTick(harness.runtime);
    // The tail is the lexically-smaller id `msg_aaaa` (created later). A
    // non-aborted, completed turn: audit runs against IT, and the aborted
    // older turn must not pause the goal.
    expect(harness.service.generateSmallModelText).toHaveBeenCalled();
    expect(promptsOf(harness.requests).length).toBeGreaterThan(0);
    harness.runtime.stop();
  });

  it('orders equal timestamps deterministically by array position', async () => {
    const harness = createHarness({
      messages: [
        assistantMessage('msg_zzzz', { time: { created: 10, completed: 11 } }),
        assistantMessage('msg_aaaa', { time: { created: 10, completed: 12 } }),
      ],
    });
    await runIdleTick(harness.runtime);
    // Authoritative array order decides the equal-time tie: `msg_zzzz` first
    // in the array is the OLDER turn; the audit evaluates `msg_aaaa`.
    expect(harness.service.generateSmallModelText).toHaveBeenCalledOnce();
    harness.runtime.stop();
  });

  it('counts reasoning tokens in the goal budget', async () => {
    const harness = createHarness({
      goalOverrides: { tokenBudget: 100, tokensUsed: 0 },
      messages: [assistantMessage('msg_1', {
        time: { created: 2, completed: 3 },
        tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 5, write: 4 } },
      })],
    });
    await runIdleTick(harness.runtime);
    // 10 + 20 + 30 + 5 + 4 = 69 budget consumed; not budgetLimited.
    const goalAfter = lastPatch(harness.requests);
    expect(goalAfter.tokensUsed).toBe(69);
    harness.runtime.stop();
  });

  it('honors the token budget when reasoning tokens cross it', async () => {
    const harness = createHarness({
      goalOverrides: { tokenBudget: 60, tokensUsed: 0 },
      messages: [assistantMessage('msg_1', {
        time: { created: 2, completed: 3 },
        tokens: { input: 10, output: 20, reasoning: 30, cache: { read: 5, write: 4 } },
      })],
    });
    await runIdleTick(harness.runtime);
    expect(lastPatch(harness.requests)).toMatchObject({ status: 'budgetLimited' });
    harness.runtime.stop();
  });

  it('recovers a persisted active goal on an already-idle session after restart', async () => {
    const requests = [];
    vi.stubGlobal('fetch', vi.fn(async (input, init = {}) => {
      const pathname = requestPath(input);
      requests.push({ pathname, method: init.method ?? 'GET' });
      if (pathname === '/session') {
        return jsonResponse([{
          id: SESSION_ID,
          parentID: undefined,
          metadata: { openchamber: { goal: { ...goal, turnsUsed: 0 } } },
        }]);
      }
      if (pathname === `/session/${SESSION_ID}` && init.method === 'PATCH') return jsonResponse(session);
      if (pathname === `/session/${SESSION_ID}`) return jsonResponse({ ...session, metadata: { openchamber: { goal: { ...goal, turnsUsed: 0 } } } });
      if (pathname === '/session/status') return jsonResponse({});
      if (pathname === `/session/${SESSION_ID}/children`) return jsonResponse([]);
      if (pathname === `/session/${SESSION_ID}/message`) {
        return jsonResponse([assistantMessage('msg_restart', { time: { created: 50, completed: 51 } })]);
      }
      if (pathname === `/session/${SESSION_ID}/prompt_async`) return jsonResponse({}, 204);
      throw new Error(`Unexpected request: ${pathname}`);
    }));
    const runtime = createSessionGoalRuntime({
      buildOpenCodeUrl: (pathname) => `http://opencode.test${pathname}`,
      getOpenCodeAuthHeaders: () => ({}),
      getSmallModelService: async () => ({ generateSmallModelText: vi.fn(async () => ({
        text: '{"verdict":"continue","note":"n"}',
        providerID: 'provider',
        modelID: 'model',
      })) }),
      isEnabled: () => true,
      kickoffQuietMs: 10,
    });
    await runtime.start({ listDirectories: async () => [DIRECTORY] });
    await vi.runOnlyPendingTimersAsync();

    // The persisted active goal recovered without any SSE event: a kickoff
    // tick ran and either audited or dispatched.
    expect(requests.some((r) => r.pathname === `/session/${SESSION_ID}/prompt_async`)).toBe(true);
    runtime.stop();
  });
});
