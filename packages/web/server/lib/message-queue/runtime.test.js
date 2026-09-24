import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CONSULT_RECEIPT_CARRIER_TEXT, createMessageQueueRuntime, parseQueuedItemInput, registerMessageQueueRoutes } from './runtime.js';

const SESSION = 'ses_queue_test_1';
const DIRECTORY = '/repo';

const item = (overrides = {}) => ({
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  ...overrides,
});

const tempDirs = [];
const makeDataDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-message-queue-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  vi.useRealTimers();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/**
 * A fake OpenCode: status map, message tail, command list, and a log of every
 * prompt/command it received.
 */
const createOpenCode = () => {
  const state = {
    statuses: {},
    tail: [],
    commands: [],
    sent: [],
    failNext: null,
    /** Next prompt_async fails (one-shot); optionally takes message reads with it. */
    failPromptOnce: false,
    /** Next prompt_async rejects like a network error (no HTTP status, one-shot). */
    failPromptNetworkOnce: false,
    /** Next prompt_async answers this HTTP status (one-shot). */
    failPromptStatusOnce: null,
    /** Next prompt_async rejects with a connection-level cause code (one-shot). */
    failPromptConnectionOnce: null,
    failMessageReadsAfterPromptFailure: false,
    /** While set, every message-tail read fails. */
    failMessageReads: false,
    /** Fail the Nth message-tail read of this runtime (1-based). */
    failMessageReadsOnCall: null,
    messageReadCalls: 0,
    /** When set, each message read shifts the next tail (last one repeats). */
    messageReadTails: null,
    /** One-shot: park the next request to this exact path until released. */
    parkNext: null,
    /** Set to the parked path once the gate was consumed (for waitFor). */
    parkedAt: null,
    /** Every request as `${method} ${pathname}`, recorded on arrival. */
    requests: [],
    /** Addressable messages by id: a GET of a missing id is a 404. */
    messages: {},
    /** How many prompt_async requests the fake received. */
    promptCalls: 0,
    /** The parsed prompt bodies the fake received, in arrival order. */
    promptBodies: [],
    /** How many session-status reads the fake received. */
    statusCalls: 0,
    /** Called with the parsed prompt body as the request arrives. */
    onPrompt: null,
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    state.requests.push(`${method} ${pathname}`);
    if (state.parkNext && state.parkNext.pathname === pathname) {
      const gate = state.parkNext;
      state.parkNext = null;
      state.parkedAt = pathname;
      await gate.promise;
      state.parkedAt = null;
    }
    if (state.failNext && state.failNext.test(pathname)) {
      state.failNext = null;
      return new Response('boom', { status: 500 });
    }
    if (pathname === '/session/status') {
      state.statusCalls += 1;
      return Response.json(state.statuses);
    }
    if (pathname.startsWith('/session/') && pathname.includes('/message/')) {
      const messageId = pathname.split('/').pop();
      const message = state.messages[messageId];
      return message ? Response.json(message) : new Response('not found', { status: 404 });
    }
    if (pathname.endsWith('/message')) {
      state.messageReadCalls += 1;
      if (state.parkMessageReadOnCall === state.messageReadCalls) {
        state.parkMessageReadOnCall = null;
        state.parkedMessageRead = true;
        await state.parkMessageReadGate;
      }
      if (state.failMessageReads) return new Response('boom', { status: 500 });
      if (state.failMessageReadsOnCall === state.messageReadCalls) return new Response('boom', { status: 500 });
      if (state.messageReadTails && state.messageReadTails.length > 0) {
        const next = state.messageReadTails.length > 1 ? state.messageReadTails.shift() : state.messageReadTails[0];
        return Response.json(next);
      }
      return Response.json(state.tail);
    }
    if (pathname === '/command') return Response.json(state.commands);
    if (method === 'POST' && pathname.endsWith('/prompt_async')) {
      state.promptCalls += 1;
      const promptBody = JSON.parse(init.body);
      state.promptBodies.push(promptBody);
      state.onPrompt?.(promptBody, state);
      if (state.failPromptOnce) {
        state.failPromptOnce = false;
        if (state.failMessageReadsAfterPromptFailure) state.failMessageReads = true;
        return new Response('boom', { status: 500 });
      }
      if (state.failPromptNetworkOnce) {
        state.failPromptNetworkOnce = false;
        if (state.failMessageReadsAfterPromptFailure) state.failMessageReads = true;
        throw new TypeError('fetch failed');
      }
      if (state.failPromptStatusOnce !== null) {
        const status = state.failPromptStatusOnce;
        state.failPromptStatusOnce = null;
        if (state.failMessageReadsAfterPromptFailure) state.failMessageReads = true;
        return new Response('boom', { status });
      }
      if (state.failPromptConnectionOnce) {
        const code = state.failPromptConnectionOnce;
        state.failPromptConnectionOnce = null;
        if (state.failMessageReadsAfterPromptFailure) state.failMessageReads = true;
        throw Object.assign(new Error('fetch failed'), { cause: { code } });
      }
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    if (method === 'POST' && pathname.endsWith('/command')) {
      state.sent.push({ path: pathname, body: JSON.parse(init.body) });
      return new Response(null, { status: 204 });
    }
    return new Response('not found', { status: 404 });
  });
  return { state, fetchImpl };
};

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, retryDelayMs, resolvePromptBody, now, persistStrictImpl } = {}) => {
  let eventHandler = () => {};
  let statusHandler = () => {};
  const broadcasts = [];
  const promptSent = [];
  const options = {
    globalEventHub: {
      subscribeEvent(handler) { eventHandler = handler; return () => {}; },
      subscribeStatus(handler) { statusHandler = handler; return () => {}; },
    },
    buildOpenCodeUrl: (fetchPath) => `http://opencode.test${fetchPath}`,
    getOpenCodeAuthHeaders: () => ({}),
    sessionKnowledgeRuntime: knowledge,
    broadcastGlobalUiEvent: (event) => broadcasts.push(event),
    onPromptSent: (sessionId) => promptSent.push(sessionId),
    dataDir,
    fetchImpl: openCode.fetchImpl,
    dispatchQuietMs: 0,
    abortHoldMs: 50,
  };
  if (retryDelayMs) options.retryDelayMs = retryDelayMs;
  if (resolvePromptBody) options.resolvePromptBody = resolvePromptBody;
  if (now) options.now = now;
  if (persistStrictImpl) options.persistStrictImpl = persistStrictImpl;
  const runtime = createMessageQueueRuntime(options);
  return {
    runtime,
    openCode,
    dataDir,
    broadcasts,
    promptSent,
    emit: (payload, directory = DIRECTORY) => eventHandler({ payload, directory }),
    connect: () => statusHandler({ type: 'connect' }),
  };
};

const settle = async (ms = 30) => {
  await new Promise((resolve) => setTimeout(resolve, ms));
};

/** Poll until `check` holds, so a test can synchronize on runtime state. */
const waitFor = async (check, { timeoutMs = 3_000, stepMs = 5 } = {}) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (check()) return;
    await settle(stepMs);
  }
  throw new Error('waitFor timed out');
};

/** A stored consult item for a directly seeded queue file (see seedQueueFile). */
const storedConsultItem = (overrides = {}) => ({
  id: 'queued-legacy-1',
  createdAt: 1_000,
  content: 'follow up',
  text: 'follow up',
  attachments: [],
  sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
  kind: 'consult',
  consult: { system: 'be terse' },
  ...overrides,
});

/**
 * Writes a queue file directly, the way an older build or a crash left it
 * behind. A version-1 file restores every consult item with a legacy witness
 * (no message id), which is the only way to reach the legacy resolve paths.
 */
const seedQueueFile = (dataDir, { version = 1, items, sessionId = SESSION, directory = DIRECTORY, revision = 1 } = {}) => {
  fs.writeFileSync(
    path.join(dataDir, 'message-queue.json'),
    JSON.stringify({ version, revision, sessions: { [sessionId]: { directory, items } } }),
  );
  return dataDir;
};

/** The legacy witness a version-1 file produces for an item (at = createdAt). */
const legacyAttemptOf = (createdAt = 1_000) => ({ legacy: true, at: createdAt });

/**
 * The stored witness for an item, read from the persisted queue file. The raw
 * witness is server-only and no longer rides the public projection (which
 * carries the boolean `attempted` instead), so tests that need its identity
 * read it through the same durable path a restart would use.
 */
const readStoredAttempt = (dataDir, itemId) => {
  const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
  for (const entry of Object.values(stored.sessions ?? {})) {
    const item = entry.items?.find((candidate) => candidate.id === itemId);
    if (item) return item.consult?.attempt ?? null;
  }
  return null;
};

describe('auto routing', () => {
  it('lets the routing hook rewrite the model of a queued prompt and a queued command', async () => {
    const resolvePromptBody = vi.fn(async (body) => {
      if (body.model?.modelID === 'auto') body.model = { providerID: 'openai', modelID: 'gpt-6-astra' };
      if (body.model === 'openchamber/auto') body.model = 'openai/gpt-6-astra';
      return null;
    });
    const { runtime, openCode, emit } = createRuntime({ resolvePromptBody });
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    openCode.state.commands = [{ name: 'review', template: 'Review $ARGUMENTS' }];
    const auto = { providerID: 'openchamber', modelID: 'auto', agent: 'build' };
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain', sendConfig: auto }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: auto }));

    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent.map((entry) => entry.body.model)).toEqual([
      { providerID: 'openai', modelID: 'gpt-6-astra' },
      'openai/gpt-6-astra',
    ]);
    expect(resolvePromptBody).toHaveBeenCalledTimes(2);
    expect(resolvePromptBody.mock.calls[0][1]).toEqual({ sessionId: SESSION, directory: DIRECTORY });
  });
});

describe('parseQueuedItemInput', () => {
  it('rejects an item the server could not deliver later', () => {
    expect(() => parseQueuedItemInput({ content: 'x' })).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ content: '', text: '' }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ attachments: [{ filename: 'a.png' }] }))).toThrow(TypeError);
  });

  it('keeps delivery fields and trims blank edges of the content', () => {
    const parsed = parseQueuedItemInput(item({ content: '\n\nhello\n', text: 'hello', agentMention: 'reviewer' }));
    expect(parsed).toEqual({
      content: 'hello',
      text: 'hello',
      agentMention: 'reviewer',
      attachments: [],
      context: [],
      sendConfig: { providerID: 'anthropic', modelID: 'claude', agent: 'build' },
    });
  });

  it('keeps captured context and rejects a malformed part', () => {
    const context = [
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } }, instructions: '' },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ];
    expect(parseQueuedItemInput(item({ context })).context).toEqual([
      { kind: 'context', text: 'Comment on `a.ts`', metadata: { openchamberContext: { kind: 'code-comment' } } },
      { kind: 'instruction', text: 'use the skill' },
      { kind: 'synthetic', text: 'conflict payload' },
    ]);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'context', text: 'no metadata' }] }))).toThrow(TypeError);
    expect(() => parseQueuedItemInput(item({ context: [{ kind: 'other', text: 'x' }] }))).toThrow(TypeError);
  });

  it('accepts an item that is only context', () => {
    const parsed = parseQueuedItemInput(item({ content: '', text: '', context: [{ kind: 'synthetic', text: 'just context' }] }));
    expect(parsed.text).toBe('');
    expect(parsed.context).toHaveLength(1);
  });
});

describe('message queue runtime', () => {
  it('delivers the head of the queue when the session goes idle, in order', async () => {
    const { runtime, openCode, emit, promptSent, broadcasts } = createRuntime();
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'first', text: 'first' }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'second', text: 'second' }));
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body).toEqual({
      model: { providerID: 'anthropic', modelID: 'claude' },
      agent: 'build',
      parts: [{ type: 'text', text: 'first' }],
    });
    expect(promptSent).toEqual([SESSION]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['second']);
    // Clients learned about the in-flight item and then the removal.
    expect(broadcasts.at(-1)).toMatchObject({
      type: 'openchamber:message-queue.updated',
      properties: { session: { sessionId: SESSION, sendingId: null } },
    });

    // The next turn: busy, then idle again — the second message goes out.
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'busy' } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(2);
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
  });

  it('does not send into a running turn even when the status event says idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Live unfinished turn: created after this runtime started.
    openCode.state.tail = [{ info: { role: 'assistant', time: { created: 10_001 } } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The reply completes: that alone drains the queue (a missed idle event
    // must not strand it).
    openCode.state.tail = [{ info: { role: 'assistant', time: { created: 10_001, completed: 10_002 } } }];
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, time: { created: 10_001, completed: 10_002 } } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('delivers past an unfinished tail that predates this runtime (dead pre-restart run)', async () => {
    const { runtime, openCode, emit } = createRuntime({ now: () => 10_000 });
    runtime.start();
    // Assistant reply interrupted by a server restart: unfinished, but older
    // than this runtime — no completion event will ever arrive for it, so it
    // must not block a restored queue forever.
    openCode.state.tail = [{ info: { role: 'assistant', time: { created: 1 } } }];
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
  });

  it('treats an unreachable OpenCode as unknown, not idle', async () => {
    const { runtime, openCode, emit } = createRuntime({ retryDelayMs: () => 10 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /\/session\/status$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    expect(openCode.state.sent).toHaveLength(0);
    // Retried after the status fetch recovers.
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('keeps a failed item and retries with backoff', async () => {
    const { runtime, openCode, emit, broadcasts } = createRuntime({ retryDelayMs: () => 20 });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.failNext = /prompt_async$/;
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
    expect(broadcasts.at(-1).properties.session.sendingId).toBeNull();
    await settle(40);
    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('holds delivery briefly after a user abort', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'message.updated', properties: { info: { role: 'assistant', sessionID: SESSION, error: { name: 'MessageAbortedError' } } } });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(10);
    expect(openCode.state.sent).toHaveLength(0);
    await settle(80);
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('honors a hold until it is released', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, true, 60_000);
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    runtime.setHold(SESSION, false);
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('keeps the session held while any owner holds it', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    expect(runtime.setHold(SESSION, true, 60_000, 'consult:run-1')).toMatchObject({ held: true });
    expect(runtime.setHold(SESSION, true, 60_000, 'auto-review')).toMatchObject({ held: true });

    // Releasing one owner (or an owner that never held) leaves the others.
    expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: true });
    expect(runtime.setHold(SESSION, false, undefined, 'never-held')).toMatchObject({ held: true });
    expect(runtime.setHold(SESSION, false)).toMatchObject({ held: true });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);

    // The last owner releases: the session is dispatchable again.
    expect(runtime.setHold(SESSION, false, undefined, 'auto-review')).toMatchObject({ held: false });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('lets an owner lapse on its own TTL without touching the others', async () => {
    let clock = 0;
    const { runtime, openCode, emit } = createRuntime({ now: () => clock });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    runtime.setHold(SESSION, true, 1_000, 'short');
    runtime.setHold(SESSION, true, 10_000, 'long');

    clock = 1_500;
    // Releasing the long owner must not resurrect the expired short one.
    expect(runtime.setHold(SESSION, false, undefined, 'long')).toMatchObject({ held: false });
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('refuses a malformed hold owner instead of folding it into the owner-less slot', () => {
    const { runtime } = createRuntime();
    expect(() => runtime.setHold(SESSION, true, 60_000, '   ')).toThrow(TypeError);
    expect(() => runtime.setHold(SESSION, true, 60_000, 42)).toThrow(TypeError);
    expect(() => runtime.setHold(SESSION, true, 60_000, 'x'.repeat(129))).toThrow(TypeError);
  });

  it('caps the owners of one session and refuses a new owner beyond it', () => {
    const { runtime } = createRuntime();
    for (let index = 0; index < 8; index += 1) {
      expect(runtime.setHold(SESSION, true, 60_000, `owner-${index}`)).toMatchObject({ held: true });
    }

    let refusal = null;
    try {
      runtime.setHold(SESSION, true, 60_000, 'owner-8');
    } catch (error) {
      refusal = error;
    }
    // A new owner is refused instead of silently dropping or clearing an
    // existing hold that its owner still relies on.
    expect(refusal?.status).toBe(429);
    expect(refusal?.message).toContain('hold owners');
    expect(runtime.setHold(SESSION, false, undefined, 'owner-8')).toMatchObject({ held: true });

    // A re-assert of an existing owner is not a new slot...
    expect(runtime.setHold(SESSION, true, 60_000, 'owner-3')).toMatchObject({ held: true });
    // ...and releasing one owner frees its slot for a genuinely new owner.
    expect(runtime.setHold(SESSION, false, undefined, 'owner-3')).toMatchObject({ held: true });
    expect(runtime.setHold(SESSION, true, 60_000, 'owner-8')).toMatchObject({ held: true });
  });

  it('lets lapsed owners free their slots without touching the live ones', async () => {
    let clock = 0;
    const { runtime, openCode, emit } = createRuntime({ now: () => clock });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    for (let index = 0; index < 8; index += 1) runtime.setHold(SESSION, true, 1_000, `owner-${index}`);

    // Every owner lapses; a later hold mutation prunes them, so the slots are
    // reusable instead of the cap staying permanently full.
    clock = 2_000;
    runtime.setHold('ses_other_hold_owner', true, 60_000, 'other');
    expect(runtime.setHold(SESSION, true, 60_000, 'fresh')).toMatchObject({ held: true });

    // The fresh owner is authoritative: the queue stays held, and once it is
    // released the item goes out (the lapsed owners did not leave it stuck).
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
    runtime.setHold(SESSION, false, undefined, 'fresh');
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
  });

  it('stops an in-flight dispatch tick when a hold lands while it awaits idleness', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    // Hold the status read open, so the tick is between its first isHeld check
    // and the send. A hold asserted in that window must still stop the send.
    let releaseStatus;
    openCode.fetchImpl.mockImplementationOnce(() => new Promise((resolve) => {
      releaseStatus = () => resolve(Response.json({}));
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle(5);
    runtime.setHold(SESSION, true, 60_000, 'consult:run-1');
    releaseStatus();
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
  });

  it('survives a restart and delivers once OpenCode reconnects', async () => {
    const dataDir = makeDataDir();
    const first = createRuntime({ dataDir });
    first.runtime.start();
    first.openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    await first.runtime.enqueue(SESSION, DIRECTORY, item({ content: 'persisted', text: 'persisted', contextPreview: 'Saved context preview' }));
    await first.runtime.flush();
    first.runtime.stop();

    const second = createRuntime({ dataDir });
    second.runtime.start();
    await second.runtime.load();
    expect(second.runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['persisted']);
    expect(second.runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Saved context preview');
    second.connect();
    await settle();
    expect(second.openCode.state.sent).toHaveLength(1);
    expect(second.openCode.state.sent[0].body.parts).toEqual([{ type: 'text', text: 'persisted' }]);
  });

  it('moves an unreadable queue file aside instead of treating it as empty', async () => {
    const dataDir = makeDataDir();
    fs.writeFileSync(path.join(dataDir, 'message-queue.json'), '{ not json');
    const { runtime } = createRuntime({ dataDir });
    await runtime.load();
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(fs.readdirSync(dataDir).some((name) => name.startsWith('message-queue.json.corrupt-'))).toBe(true);
  });

  it('refuses to remove or take the item currently being sent', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    let release;
    // status map, message tail, then the prompt itself (held open until released)
    openCode.fetchImpl.mockImplementationOnce(async () => Response.json({}))
      .mockImplementationOnce(async () => Response.json([]))
      .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);

    await expect(runtime.remove(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    await expect(runtime.take(SESSION, itemId)).rejects.toMatchObject({ status: 409 });
    const taken = await runtime.takeAll(SESSION);
    expect(taken.items).toEqual([]);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);

    release();
    await settle();
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(0);
  });

  it('take hands back the full payload and leaves the rest queued', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
    const first = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'with image', attachments: [attachment] }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain' }));

    expect(runtime.sessionSnapshot(SESSION).items[0].attachments[0]).not.toHaveProperty('dataUrl');
    const taken = await runtime.take(SESSION, first.itemId);
    expect(taken.item.attachments[0].dataUrl).toBe(attachment.dataUrl);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['plain']);

    const all = await runtime.takeAll(SESSION);
    expect(all.items.map((entry) => entry.content)).toEqual(['plain']);
    expect(runtime.snapshot().sessions).toEqual([]);
  });

  it('retains a bounded context preview in snapshots and broadcasts without exposing the full payload', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'context', text: 'Full quoted content', metadata: { openchamberContext: { kind: 'chat-quote', quote: 'Original answer', text: 'Explain this' } } }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'Explain this' }));
    const projected = runtime.sessionSnapshot(SESSION).items[0];
    expect(projected.contextPreview).toBe('Explain this');
    expect(projected.content).toBe('');
    expect(projected.text).toBe('');
    expect(projected).not.toHaveProperty('context');
    expect(broadcasts.at(-1).properties.session.items[0].contextPreview).toBe('Explain this');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
    expect(taken.item.content).toBe('');

    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context, contextPreview: 'a'.repeat(5000) }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('a'.repeat(100) + '...');
  });

  it('derives a preview for older queued annotations without a saved summary', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '', text: '', context: [
      { kind: 'instruction', text: 'Use the skill' },
      { kind: 'context', text: 'Model-facing wrapper', metadata: { openchamberContext: { kind: 'browser-annotation', text: 'Fix the button\nMore detail' } } },
    ] }));
    expect(runtime.sessionSnapshot(SESSION).items[0].contextPreview).toBe('Fix the button...');
  });

  it('names the directory in the broadcast that empties a queue', async () => {
    // The UI keys its projection by directory; without it the client cannot
    // tell which queue just delivered its last message and keeps showing it.
    const { runtime, emit, broadcasts, openCode } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();

    expect(openCode.state.sent).toHaveLength(1);
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toEqual({ sessionId: SESSION, directory: DIRECTORY, items: [], sendingId: null });
  });

  it('a consult item is never dispatched by the tick even when idle and at the head', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult', consult: { system: 'be terse' } }));
    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
  });

  it('a normal item behind a claimed consult item is not delivered', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult', consult: { system: 'be terse' } }));
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    // A claim both marks the item and holds the session for its owner; until
    // claim() lands the hold is asserted directly — the tick reads the same
    // owner hold the claim would set.
    runtime.setHold(SESSION, true, 60_000, 'consult:run-1');
    openCode.state.statuses = {};
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(0);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['follow up', 'plain']);
  });

  it('evicts the oldest normal item instead of a consult item when the queue is full', async () => {
    const { runtime, openCode } = createRuntime();
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    const consult = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult', content: 'consult' }));
    for (let index = 0; index < 19; index += 1) {
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: `normal-${index}`, text: `normal-${index}` }));
    }
    // 20 items: consult head + 19 normals; the next enqueue evicts the oldest
    // normal item (normal-0), never the consult item.
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'newest', text: 'newest' }));
    const items = runtime.sessionSnapshot(SESSION).items;
    expect(items).toHaveLength(20);
    expect(items.some((entry) => entry.id === consult.itemId)).toBe(true);
    expect(items.some((entry) => entry.content === 'normal-0')).toBe(false);
    expect(items.at(-1)?.content).toBe('newest');
  });

  it('refuses to enqueue when a full queue holds only consult items', async () => {
    const { runtime, openCode } = createRuntime();
    runtime.start();
    openCode.state.statuses = { [SESSION]: { type: 'busy' } };
    for (let index = 0; index < 20; index += 1) {
      await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult', content: `consult-${index}` }));
    }
    await expect(runtime.enqueue(SESSION, DIRECTORY, item({ content: 'overflow', text: 'overflow' }))).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('pending consultations'),
    });
    const items = runtime.sessionSnapshot(SESSION).items;
    expect(items).toHaveLength(20);
    expect(items.every((entry) => entry.kind === 'consult')).toBe(true);
    expect(items.some((entry) => entry.content === 'overflow')).toBe(false);
  });

  describe('session cap eviction', () => {
    const bulkSession = (index) => `ses_queue_bulk_${index}`;
    const seedBulkSessions = async (runtime, count, start = 0) => {
      for (let index = start; index < start + count; index += 1) {
        await runtime.enqueue(bulkSession(index), DIRECTORY, item({ content: `bulk-${index}`, text: `bulk-${index}` }));
      }
    };

    it('evicts the oldest session when the session cap is exceeded', async () => {
      const { runtime } = createRuntime();
      // Queue bookkeeping only: with no dispatch loop the items stay where the
      // eviction assertions can see them.
      runtime.stop();
      await seedBulkSessions(runtime, 50);
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      expect(runtime.snapshot().sessions).toHaveLength(50);
      expect(runtime.sessionSnapshot(bulkSession(0)).items).toEqual([]);
      expect(runtime.sessionSnapshot('ses_queue_cap_new').items).toHaveLength(1);
      await runtime.flush();
    });

    it('never evicts a session holding an unclaimed consult item', async () => {
      const { runtime } = createRuntime();
      runtime.stop();
      await runtime.enqueue(bulkSession(0), DIRECTORY, item({ kind: 'consult', consult: { system: 'be terse' } }));
      await seedBulkSessions(runtime, 49, 1);
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      // The queued consultation is authoritative: the session survives and the
      // next-oldest normal session is evicted in its place.
      expect(runtime.sessionSnapshot(bulkSession(0)).items).toHaveLength(1);
      expect(runtime.sessionSnapshot(bulkSession(0)).items[0].kind).toBe('consult');
      expect(runtime.sessionSnapshot(bulkSession(1)).items).toEqual([]);
      expect(runtime.sessionSnapshot('ses_queue_cap_new').items).toHaveLength(1);
      await runtime.flush();
    });

    it('never evicts a session whose consult item is claimed', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.stop();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(bulkSession(0), DIRECTORY, item({ kind: 'consult', consult: { system: 'be terse' } }));
      await runtime.claim(bulkSession(0), itemId, 'consult:run-1', 60_000);
      await seedBulkSessions(runtime, 49, 1);
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      const items = runtime.sessionSnapshot(bulkSession(0)).items;
      expect(items).toHaveLength(1);
      expect(items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(runtime.sessionSnapshot(bulkSession(1)).items).toEqual([]);
      await runtime.flush();
    });

    it('never evicts a session with an active hold', async () => {
      const { runtime } = createRuntime();
      runtime.stop();
      await seedBulkSessions(runtime, 50);
      runtime.setHold(bulkSession(0), true, 60_000, 'auto-review');
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      expect(runtime.sessionSnapshot(bulkSession(0)).items).toHaveLength(1);
      expect(runtime.sessionSnapshot(bulkSession(1)).items).toEqual([]);
      await runtime.flush();
    });

    it('never evicts a session whose send is in flight', async () => {
      const { runtime, openCode, emit } = createRuntime();
      runtime.start();
      // Start the oldest session's send and hold the prompt open, so the
      // dispatch is still in flight when the cap is exceeded.
      let release;
      openCode.fetchImpl.mockImplementationOnce(async () => Response.json({}))
        .mockImplementationOnce(async () => Response.json([]))
        .mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve(new Response(null, { status: 204 })); }));
      const oldest = await runtime.enqueue(bulkSession(0), DIRECTORY, item({ content: 'bulk-0', text: 'bulk-0' }));
      emit({ type: 'session.status', properties: { sessionID: bulkSession(0), status: { type: 'idle' } } });
      await settle();
      expect(runtime.sessionSnapshot(bulkSession(0)).sendingId).toBe(oldest.itemId);
      // Freeze the loop so the seeded queues stay visible; stop() does not
      // touch the in-flight send, so its `sending` entry must survive.
      runtime.stop();
      await seedBulkSessions(runtime, 49, 1);
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      // A mid-send session holds authoritative work: the oldest survives and
      // the next-oldest normal session is evicted in its place.
      expect(runtime.sessionSnapshot(bulkSession(0)).items).toHaveLength(1);
      expect(runtime.sessionSnapshot(bulkSession(0)).sendingId).toBe(oldest.itemId);
      expect(runtime.sessionSnapshot(bulkSession(1)).items).toEqual([]);
      expect(runtime.sessionSnapshot('ses_queue_cap_new').items).toHaveLength(1);
      expect(runtime.snapshot().sessions).toHaveLength(50);
      await runtime.flush();

      release();
      await settle();
      expect(runtime.sessionSnapshot(bulkSession(0)).items).toEqual([]);
    });

    it('refuses a new session and leaves every queue untouched when no session is evictable', async () => {
      const { runtime } = createRuntime();
      runtime.stop();
      await seedBulkSessions(runtime, 50);
      for (let index = 0; index < 50; index += 1) runtime.setHold(bulkSession(index), true, 60_000, 'auto-review');
      const before = runtime.snapshot();

      await expect(runtime.enqueue('ses_queue_cap_refused', DIRECTORY, item({ content: 'overflow', text: 'overflow' }))).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('full of active sessions'),
      });
      // Neither revision nor any queue may change, and the refused session must
      // not be left behind as a phantom queue.
      expect(runtime.snapshot()).toEqual(before);
      expect(runtime.sessionSnapshot('ses_queue_cap_refused')).toEqual({
        sessionId: 'ses_queue_cap_refused',
        directory: '',
        items: [],
        sendingId: null,
      });
      await runtime.flush();
    });

    it('evicts that session again once its consult item is removed', async () => {
      const { runtime } = createRuntime();
      runtime.stop();
      const consult = await runtime.enqueue(bulkSession(0), DIRECTORY, item({ kind: 'consult', consult: { system: 'be terse' } }));
      await runtime.enqueue(bulkSession(0), DIRECTORY, item({ content: 'bulk-0', text: 'bulk-0' }));
      await seedBulkSessions(runtime, 49, 1);
      await runtime.remove(bulkSession(0), consult.itemId);

      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      expect(runtime.sessionSnapshot(bulkSession(0)).items).toEqual([]);
      expect(runtime.sessionSnapshot('ses_queue_cap_new').items).toHaveLength(1);
      expect(runtime.snapshot().sessions).toHaveLength(50);
      await runtime.flush();
    });

    it('evicts that session again once its hold lapses', async () => {
      let clock = 0;
      const { runtime } = createRuntime({ now: () => clock });
      runtime.stop();
      await seedBulkSessions(runtime, 50);
      runtime.setHold(bulkSession(0), true, 1_000, 'auto-review');

      clock = 2_000;
      await runtime.enqueue('ses_queue_cap_new', DIRECTORY, item({ content: 'newest', text: 'newest' }));

      expect(runtime.sessionSnapshot(bulkSession(0)).items).toEqual([]);
      expect(runtime.sessionSnapshot('ses_queue_cap_new').items).toHaveLength(1);
      expect(runtime.snapshot().sessions).toHaveLength(50);
      await runtime.flush();
    });
  });

  it('reorders only with a complete permutation', async () => {
    const { runtime } = createRuntime();
    runtime.start();
    const a = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'a' }));
    const b = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'b' }));
    await expect(runtime.reorder(SESSION, [b.itemId])).rejects.toThrow(TypeError);
    await runtime.reorder(SESSION, [b.itemId, a.itemId]);
    expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['b', 'a']);
  });

  describe('claim', () => {
    const consultItem = (overrides = {}) => item({ kind: 'consult', consult: { system: 'be terse' }, ...overrides });

    it('marks the item claimed only after its owner hold exists, so the sweep cannot revert a fresh claim', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());

      // The owner's previous reservation lapses just before the claim: the
      // claim's setHold runs the expiry sweep, and a claim marked before its
      // own hold exists would be reverted right here while still reporting
      // success.
      clock = 2_000;
      const result = await runtime.claim(SESSION, itemId, 'consult:run-2', 1_000);
      expect(result.claimed).toBe(true);
      clock = 2_100;
      // A sweep pass (any hold mutation) must keep the fresh claim alive.
      runtime.setHold('ses_other_regress', true, 60_000, 'other');
      const snapshot = runtime.sessionSnapshot(SESSION).items[0];
      expect(snapshot.claimed).toMatchObject({ owner: 'consult:run-2' });
      expect(snapshot.kind).toBe('consult');
      // The payload route still accepts the claim's owner immediately after.
      await runtime.setConsultPayload(SESSION, itemId, 'consult:run-2', { system: 'updated' });
      expect(runtime.sessionSnapshot(SESSION).items[0].consult).toEqual({ system: 'updated' });
    });

    it('marks the head consult item claimed and holds the session for its owner', async () => {
      const { runtime, openCode, emit, broadcasts } = createRuntime();
      runtime.start();
      openCode.state.statuses = { [SESSION]: { type: 'busy' } };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      // Clearing the fake busy status makes isSessionIdle read idle.
      openCode.state.statuses = {};
      const result = await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      expect(result.claimed).toBe(true);
      expect(result.item.claimed).toMatchObject({ owner: 'consult:run-1' });
      // The claim's hold keeps the generic dispatcher away.
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(broadcasts.at(-1).properties.session.items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
    });

    it('refuses with not-idle while the fake status is busy', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = { [SESSION]: { type: 'busy' } };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await expect(runtime.claim(SESSION, itemId, 'consult:run-1')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-idle'),
      });
      expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('claimed');
    });

    it('refuses a different owner once claimed and lets the same owner re-claim', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      await expect(runtime.claim(SESSION, itemId, 'consult:run-2')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('already-claimed'),
      });
      // Same owner re-claims: still claimed, and the hold extends.
      const again = await runtime.claim(SESSION, itemId, 'consult:run-1', 90_000);
      expect(again.claimed).toBe(true);
      expect(again.item.claimed.owner).toBe('consult:run-1');
    });

    it('refuses a normal item with not-consult and a non-head consult with not-head', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      const queue = runtime.sessionSnapshot(SESSION).items;
      await expect(runtime.claim(SESSION, queue[0].id, 'consult:run-1')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-consult'),
      });
      await expect(runtime.claim(SESSION, queue[1].id, 'consult:run-1')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-head'),
      });
    });
  });

  describe('setConsultPayload', () => {
    const consultItem = (overrides = {}) => item({ kind: 'consult', consult: { system: 'be terse' }, ...overrides });

    it('merges the consult payload for the claiming owner', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.setConsultPayload(SESSION, itemId, 'consult:run-1', { system: 'updated system' });
      expect(result.ok).toBe(true);
      expect(result.item.consult).toEqual({ system: 'updated system' });
      expect(runtime.sessionSnapshot(SESSION).items[0].consult).toEqual({ system: 'updated system' });
    });

    it('refuses a foreign owner and an oversized payload', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      await expect(runtime.setConsultPayload(SESSION, itemId, 'consult:other', { system: 'x' })).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-claiming'),
      });
      await expect(runtime.setConsultPayload(SESSION, itemId, 'consult:run-1', { system: 'y'.repeat(24_001) })).rejects.toThrow(TypeError);
      await expect(runtime.setConsultPayload(SESSION, itemId, 'consult:run-1', { textPartMetadata: { big: 'z'.repeat(8_000) } })).rejects.toThrow(TypeError);
    });
  });

  describe('manual removal clears the removed claim owner hold (REQ-2)', () => {
    it('removing a claimed consult item releases its owner hold', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult' }));
      runtime.setHold(SESSION, true, 60_000, 'consult:other');
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);

      await runtime.remove(SESSION, itemId);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
      // The unrelated owner's hold is untouched.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:other')).toMatchObject({ held: false });
    });

    it('removing a normal item leaves holds untouched', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const consult = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult' }));
      const normal = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      await runtime.claim(SESSION, consult.itemId, 'consult:run-1', 60_000);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);

      await runtime.remove(SESSION, normal.itemId);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
    });

    it("clear releases only the removed consult items' claim owners", async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const first = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult', content: 'one' }));
      await runtime.claim(SESSION, first.itemId, 'consult:run-1', 60_000);
      runtime.setHold(SESSION, true, 60_000, 'other-feature');
      const second = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));

      await runtime.clear(SESSION);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
      // The unrelated owner survived the clear.
      expect(runtime.setHold(SESSION, false, undefined, 'other-feature')).toMatchObject({ held: false });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      void second;
    });
  });

  describe('hasActiveConsultReservation', () => {
    it('is true only while a claimed consult item holds a live reservation', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      // Normal items never reserve the session.
      await runtime.enqueue('ses_queue_test_normal', DIRECTORY, item());
      expect(runtime.hasActiveConsultReservation('ses_queue_test_normal')).toBe(false);

      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult' }));
      // Unclaimed consult items are not reservations.
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      expect(runtime.hasActiveConsultReservation('ses_unknown_1')).toBe(false);
      expect(runtime.hasActiveConsultReservation('not a session id')).toBe(false);

      // A lapsed hold ends the reservation (the lazy read prunes it).
      clock = 2_000;
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('treats an owner-less claim as a reservation while its legacy hold is live', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult' }));
      // No owner in the claim route body: the empty-string legacy slot.
      const claimed = await runtime.claim(SESSION, itemId, undefined, 1_000);
      expect(claimed.item.claimed).toMatchObject({ owner: '' });
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);

      // The live legacy hold survives a sweep pass.
      clock = 500;
      runtime.setHold('ses_other_ownerless', true, 60_000, 'other');
      const snapshot = runtime.sessionSnapshot(SESSION).items[0];
      expect(snapshot.claimed).toMatchObject({ owner: '' });
      expect(snapshot.kind).toBe('consult');

      // When the legacy hold lapses, the claim is cleared (kind kept).
      clock = 2_000;
      runtime.setHold('ses_other_ownerless', true, 60_000, 'other');
      const lapsed = runtime.sessionSnapshot(SESSION).items[0];
      expect(lapsed).not.toHaveProperty('claimed');
      expect(lapsed.kind).toBe('consult');
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('is false after the owner releases the hold or the item is removed', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ kind: 'consult' }));
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);

      runtime.setHold(SESSION, false, undefined, 'consult:run-1');
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);

      // Re-claim then remove the item: no reservation remains.
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      await runtime.remove(SESSION, itemId);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });
  });

  describe('dispatchConsult outcomes', () => {
    const consultItem = (overrides = {}) => item({
      kind: 'consult',
      consult: { system: 'be terse', textPartMetadata: { openchamberConsult: { model: 'glm-4.7' } } },
      ...overrides,
    });

    it('dispatches with system + primary text part metadata, then cleans up', async () => {
      const { runtime, openCode, broadcasts } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toMatchObject({ status: 'dispatched', evidence: 'admission' });
      expect(openCode.state.sent).toHaveLength(1);
      const body = openCode.state.sent[0].body;
      expect(body.system).toBe('be terse');
      expect(body.parts[0]).toEqual({
        type: 'text',
        text: 'follow up',
        metadata: { openchamberConsult: { model: 'glm-4.7' } },
      });
      // The request carries the witness' own message id, so the send is
      // addressable afterwards.
      expect(body.messageID).toMatch(/^msg_[A-Za-z0-9_-]{1,120}$/);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(broadcasts.at(-1).properties.session.items).toEqual([]);
      // The owner hold was released: a later normal dispatch is possible.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('commits and flushes the witness before the request is issued', async () => {
      const dataDir = makeDataDir();
      const openCode = createOpenCode();
      let persistedWhenRequestArrived = null;
      openCode.state.onPrompt = (body) => {
        // The fake is the request's I/O boundary: by the time it sees the
        // prompt, the witness must already be durable on disk.
        const stored = JSON.parse(fs.readFileSync(path.join(dataDir, 'message-queue.json'), 'utf8'));
        persistedWhenRequestArrived = stored.sessions[SESSION].items[0].consult?.attempt ?? null;
        expect(body.messageID).toBe(persistedWhenRequestArrived?.messageId);
      };
      const { runtime } = createRuntime({ dataDir, openCode });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toMatchObject({ status: 'dispatched', evidence: 'admission' });
      expect(persistedWhenRequestArrived).toMatchObject({
        attemptId: expect.stringMatching(/^att_[A-Za-z0-9_-]{8,64}$/),
        messageId: expect.stringMatching(/^msg_/),
      });
    });

    it('a removal during the witness write is not overtaken by the request', async () => {
      const dataDir = makeDataDir();
      let releaseWrite;
      const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
      const { runtime, openCode } = createRuntime({
        dataDir,
        // Park the strict witness write: while it is pending, remove() runs.
        persistStrictImpl: async ({ filePath, payload }) => {
          await writeGate;
          fs.writeFileSync(filePath, payload, 'utf8');
        },
      });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');

      const pending = runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      // The runtime has written the in-memory witness and is awaiting the
      // write; remove() is accepted because only `sending` blocks it.
      await waitFor(() => runtime.sessionSnapshot(SESSION).items[0]?.attempted === true);
      const removed = await runtime.remove(SESSION, itemId);
      expect(removed.session.items).toEqual([]);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);

      releaseWrite();
      expect(await pending).toEqual({ status: 'not-found' });
      // Nothing was sent, the item stays removed, and the removal's hold
      // release was not resurrected by the dispatch.
      expect(openCode.state.promptCalls).toBe(0);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('a claim lost during the witness write removes the dispatch’s own witness and sends nothing', async () => {
      let clock = 0;
      let releaseWrite;
      const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
      const { runtime, openCode } = createRuntime({
        now: () => clock,
        // Park the strict witness write: while it is pending, the reservation
        // lapses (a sweep on another session's hold mutation clears the claim).
        persistStrictImpl: async ({ filePath, payload }) => {
          await writeGate;
          fs.writeFileSync(filePath, payload, 'utf8');
        },
      });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);

      const pending = runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      await waitFor(() => runtime.sessionSnapshot(SESSION).items[0]?.attempted === true);
      // Let the reservation lapse (the dispatch extended it to the cap, so
      // the clock passes 10 minutes) and a sweep on another session clear the
      // claim while the witness write is still pending.
      clock = 700_000;
      runtime.setHold('ses_other_race', true, 60_000, 'other');
      releaseWrite();

      expect(await pending).toEqual({ status: 'claim-lost' });
      expect(openCode.state.promptCalls).toBe(0);
      // This dispatch sent nothing, so its own witness was removed again: the
      // item is returned to the normal recoverable state (unclaimed plus
      // witness-absent is the server's proof that nothing was sent), which is
      // what makes the Resume affordance appear.
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].attempted).toBeUndefined();
      expect(snapshot[0].claimed).toBeUndefined();
      expect(snapshot[0].recoverable).toBe(true);
      // Nothing was sent, so the resolve predicate reads resumable again and a
      // fresh owner may claim it.
      expect(await runtime.resolveConsult(SESSION, itemId)).toEqual({ status: 'resumable' });
      const claimed = await runtime.claim(SESSION, itemId, 'consult:run-2', 60_000);
      expect(claimed.claimed).toBe(true);
      expect(claimed.item.claimed).toMatchObject({ owner: 'consult:run-2' });
      expect(claimed.item).not.toHaveProperty('recoverable');
    });

    it('a foreign send in flight during the parked witness write runs the cleanup and stamps recoverable', async () => {
      let clock = 0;
      let releaseWrite;
      const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
      const { runtime, openCode, emit } = createRuntime({
        now: () => clock,
        persistStrictImpl: async ({ filePath, payload }) => {
          await writeGate;
          fs.writeFileSync(filePath, payload, 'utf8');
        },
      });
      runtime.start();
      openCode.state.statuses = {};
      const consult = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, consult.itemId, 'consult:run-1', 1_000);
      const normal = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      // The normal item moves in front of the claimed consult item so the tick
      // can deliver it once the consult hold lapses.
      await runtime.reorder(SESSION, [normal.itemId, consult.itemId]);

      const pending = runtime.dispatchConsult(SESSION, consult.itemId, 'consult:run-1');
      await waitFor(() => runtime.sessionSnapshot(SESSION).items.find((entry) => entry.id === consult.itemId)?.attempted === true);

      // The consult hold lapses (the dispatch extended it to the cap) and the
      // tick starts the normal head's send. Its prompt is parked so `sending`
      // stays set while the consult dispatch is still in its witness write.
      clock = 700_000;
      let releasePrompt;
      openCode.state.parkNext = {
        pathname: `/session/${SESSION}/prompt_async`,
        promise: new Promise((resolve) => { releasePrompt = resolve; }),
      };
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await waitFor(() => openCode.state.parkedAt === `/session/${SESSION}/prompt_async`);
      expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(normal.itemId);

      releaseWrite();
      expect(await pending).toEqual({ status: 'claim-lost' });

      // The cleanup ran with a foreign send in flight: the own witness is
      // gone, and the item (unclaimed + unwitnessed) is returned to the
      // recoverable state.
      const cleared = runtime.sessionSnapshot(SESSION).items.find((entry) => entry.id === consult.itemId);
      expect(cleared.attempted).toBeUndefined();
      expect(cleared.claimed).toBeUndefined();
      expect(cleared.recoverable).toBe(true);
      // Resolve answers `sending` while the foreign send is still in flight
      // (that dispatch may be the one that lands the turn), and `resumable`
      // once it settles: the cleanup itself proved nothing was sent by us.
      expect(await runtime.resolveConsult(SESSION, consult.itemId)).toEqual({ status: 'sending' });

      // The foreign send is untouched: it still owns the in-flight slot and
      // completes normally.
      expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(normal.itemId);
      releasePrompt();
      await settle();
      expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
      expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([consult.itemId]);
      expect(openCode.state.promptCalls).toBe(1);
      expect(await runtime.resolveConsult(SESSION, consult.itemId)).toEqual({ status: 'resumable' });
    });

    it('a malformed stored witness reads as a legacy witness, never as never-sent', async () => {
      // A version-2 file whose attempt record is present but unreadable: the
      // boundary reader cannot validate it, so it must normalize to the
      // conservative legacy witness instead of dropping to "no attempt".
      const dataDir = seedQueueFile(makeDataDir(), {
        version: 2,
        items: [storedConsultItem({ consult: { system: 'be terse', attempt: { attemptId: 'not-an-attempt' } } })],
      });
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      await runtime.load();

      const restored = runtime.sessionSnapshot(SESSION).items[0];
      expect(restored.attempted).toBe(true);
      expect(restored.recoverable).toBeUndefined();
      // The normalization is a legacy witness, not a modern one: with no
      // receipt runId there is nothing the marker tail could prove, so resolve
      // answers unknown without ever reading an address.
      expect(await runtime.resolveConsult(SESSION, 'queued-legacy-1')).toEqual({ status: 'unresolved' });
      expect(openCode.state.requests.some((entry) => entry.includes('/message/msg_'))).toBe(false);
      // The claim refuses it; the sweep withholds the recovery marker.
      runtime.setHold('ses_other_malformed', true, 60_000, 'other');
      expect(runtime.sessionSnapshot(SESSION).items[0].recoverable).toBeUndefined();
      await expect(runtime.claim(SESSION, 'queued-legacy-1', 'consult:run-1')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('attempt-recorded'),
      });
      expect(openCode.state.promptCalls).toBe(0);
    });

    it('a failed strict witness write sends nothing and answers attempt-write-failed', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      await runtime.flush();
      const before = runtime.snapshot();

      // Break the write path under the running runtime: with a regular file
      // where the data directory should be, mkdir fails and persistStrict
      // rejects. The in-memory queue is unaffected.
      fs.rmSync(dataDir, { recursive: true, force: true });
      fs.writeFileSync(dataDir, 'not a directory');
      try {
        expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'attempt-write-failed' });
      } finally {
        fs.rmSync(dataDir, { force: true });
      }

      // Fail-closed: no request and no in-memory witness. The queue contents
      // are exactly as they were before the attempt (the revision counter
      // moved, which no client saw because no broadcast was emitted).
      expect(openCode.state.promptCalls).toBe(0);
      expect(runtime.snapshot().sessions).toEqual(before.sessions);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(snapshot[0]).not.toHaveProperty('attempted');
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      // A later dispatch after the write path heals works normally.
      fs.mkdirSync(dataDir, { recursive: true });
      const retry = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(retry.status).toBe('dispatched');
      expect(openCode.state.promptCalls).toBe(1);
    });

    it('a version-2 file restores the witness and refuses the resume it would enable', async () => {
      // A version-2 file from a dispatch whose response was lost: the witness
      // survived the restart, so the item may be delivered and must never be
      // resumed (a new request could duplicate the turn).
      const attempt = { attemptId: 'att_restored01', messageId: 'msg_restored01', at: 1_500 };
      const dataDir = seedQueueFile(makeDataDir(), {
        version: 2,
        items: [storedConsultItem({ consult: { system: 'be terse', attempt } })],
      });
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      await runtime.load();
      const restored = runtime.sessionSnapshot(SESSION).items[0];
      // The public projection carries the boolean only; the witness itself is
      // server-only state. The stale synthesis dropped on restore left no
      // model-facing consult fields, but the witness survived in the file.
      expect(restored.attempted).toBe(true);
      expect(restored.consult).toEqual({});
      expect(readStoredAttempt(dataDir, 'queued-legacy-1')).toEqual(attempt);
      // The claim cannot survive the restart, and the witness withholds the
      // recovery marker: there is no resume affordance for this item.
      expect(restored.claimed).toBeUndefined();
      expect(restored.recoverable).toBeUndefined();
      await expect(runtime.claim(SESSION, 'queued-legacy-1', 'consult:run-1')).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('attempt-recorded'),
      });
      // No claim, so the dispatch entry order refuses it as claim-lost: no
      // request can be issued either way.
      const before = runtime.snapshot();
      expect(await runtime.dispatchConsult(SESSION, 'queued-legacy-1', 'consult:run-1')).toEqual({ status: 'claim-lost' });
      expect(runtime.snapshot()).toEqual(before);
      expect(openCode.state.promptCalls).toBe(0);
    });

    it('attempt-present refuses a re-dispatch for a claimed witnessed item and mutates nothing', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      // An ambiguous failure leaves the item claimed with its witness.
      openCode.state.failPromptStatusOnce = 500;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const before = runtime.snapshot();

      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'attempt-present' });
      // Nothing mutated: same revision, queue, witness, claim, and hold.
      expect(runtime.snapshot()).toEqual(before);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      expect(openCode.state.promptCalls).toBe(1);
    });

    it('an attachment-only consult carries its receipt on one synthetic text part before the files', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
      const metadata = { openchamberConsultReceipt: { runID: 'run-1' } };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        content: '',
        text: '',
        attachments: [attachment],
        consult: { system: 'be terse', textPartMetadata: metadata },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');

      expect(result.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
      const parts = openCode.state.sent[0].body.parts;
      // Exactly one synthetic carrier text part, before the file parts, so the
      // receipt lands even though OpenCode's file parts have no metadata field.
      expect(parts).toEqual([
        { type: 'text', text: CONSULT_RECEIPT_CARRIER_TEXT, synthetic: true, metadata },
        { type: 'file', mime: 'image/png', filename: 'shot.png', url: attachment.dataUrl },
      ]);
      const carriers = parts.filter((part) => part.type === 'text');
      expect(carriers).toHaveLength(1);
      expect(carriers[0].metadata).toEqual(metadata);
    });

    it('an attachment-only consult: the tail marker is now findable by runId', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        content: '',
        text: '',
        attachments: [attachment],
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      // Ambiguous failure, but the receipt ride-along now gives the acting
      // turn a text-part marker the tail read can match by runId: the send
      // landed and the existing outcome mapping resolves it as delivered.
      openCode.state.messageReadTails = [[{
        info: { id: 'msg-marker', role: 'user' },
        parts: [{ type: 'text', text: CONSULT_RECEIPT_CARRIER_TEXT, synthetic: true, metadata: { openchamberConsultReceipt: { runID: 'run-1' } } }],
      }]];
      openCode.state.failPromptOnce = true;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toMatchObject({ status: 'dispatched', delivery: 'confirmed-after-failure' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    });

    it('a consult with context parts keeps the context metadata and carries the receipt on a synthetic part', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const metadata = { openchamberConsultReceipt: { runID: 'run-1' } };
      const contextMetadata = { openchamberContext: { kind: 'chat-quote', quote: 'q', text: 'why?' } };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        content: '',
        text: '',
        attachments: [{ id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' }],
        context: [{ kind: 'context', text: 'the diff', metadata: contextMetadata }],
        consult: { system: 'be terse', textPartMetadata: metadata },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');

      expect(result.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
      const parts = openCode.state.sent[0].body.parts;
      // The first existing text part (the context part, since the user text is
      // empty) already carries its own metadata: attaching the receipt there
      // would overwrite it. The synthetic carrier goes before the files
      // instead, and the context part keeps its own payload.
      expect(parts).toEqual([
        { type: 'text', text: CONSULT_RECEIPT_CARRIER_TEXT, synthetic: true, metadata },
        { type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,AAA=' },
        { type: 'text', text: 'the diff', synthetic: true, metadata: contextMetadata },
      ]);
    });

    it('answers not-found and not-consult as structured outcomes', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      expect(await runtime.dispatchConsult(SESSION, 'missing', 'consult:run-1')).toEqual({ status: 'not-found' });

      const normal = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      expect(await runtime.dispatchConsult(SESSION, normal.itemId, 'consult:run-1')).toEqual({ status: 'not-consult' });
    });

    it('answers claim-lost for a foreign owner and keeps the item and claim', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:other')).toEqual({ status: 'claim-lost' });
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(openCode.state.sent).toHaveLength(0);
    });

    it('answers busy while the session is busy and keeps the item and claim', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.statuses = { [SESSION]: { type: 'busy' } };
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'busy' });
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(openCode.state.sent).toHaveLength(0);
    });

    it('refuses a second dispatch of an in-flight witnessed item as attempt-present, keeping the item and claim', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      // Park the request itself: the witness is already committed when it
      // reaches the fake, so a second dispatch must refuse it.
      let releasePrompt;
      openCode.state.parkNext = {
        pathname: `/session/${SESSION}/prompt_async`,
        promise: new Promise((resolve) => { releasePrompt = resolve; }),
      };
      const pending = runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      await waitFor(() => openCode.state.parkedAt === `/session/${SESSION}/prompt_async`);
      expect(runtime.sessionSnapshot(SESSION).sendingId).toBe(itemId);
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'attempt-present' });
      // Nothing was mutated by the refusal: same item, claim, and hold.
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      expect(openCode.state.requests.filter((entry) => entry.endsWith('/prompt_async'))).toHaveLength(1);
      releasePrompt();
      expect((await pending).status).toBe('dispatched');
    });

    it('confirms the delivery when the acting turn\'s marker appears during the polling window', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const other = { info: { id: 'msg-other', role: 'user' }, parts: [{ type: 'text', text: 'another client' }] };
      // Mirrors `toConsultReceiptMetadata(buildConsultReceipt(...))` from the
      // UI contract: carrier key `openchamberConsultReceipt`, field `runID`.
      const marker = {
        info: { id: 'msg-marker', role: 'user' },
        parts: [{ type: 'text', text: 'the consult', metadata: { openchamberConsultReceipt: { runID: 'run-1' } } }],
      };
      // Poll 1 and 2 miss, poll 3 finds this turn's marker.
      openCode.state.messageReadTails = [[other], [other], [other, marker]];
      openCode.state.failPromptOnce = true;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toMatchObject({ status: 'dispatched', delivery: 'confirmed-after-failure' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('another client\'s new user message never counts; an HTTP 400 proves non-acceptance', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      // A brand-new user message exists, but it carries no matching marker.
      openCode.state.tail = [{ info: { id: 'msg-other', role: 'user' }, parts: [{ type: 'text', text: 'another client' }] }];
      openCode.state.failPromptStatusOnce = 400;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      // A 4xx is the server rejecting before acceptance: proven non-acceptance
      // plus correlated reads without a marker → definite failure.
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('a preparation failure (routing hook throws) is a definite not-sent with no request issued', async () => {
      const dataDir = makeDataDir();
      const resolvePromptBody = async () => {
        throw new Error('routing hook exploded');
      };
      const { runtime, openCode } = createRuntime({ dataDir, resolvePromptBody });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');

      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      // Preparation never crossed the request boundary: definite not-sent.
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(openCode.state.promptCalls).toBe(0);
      // The witness, the item, and the reservation are unwound together.
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.sessionSnapshot(SESSION).sendingId).toBeNull();
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
      // The owner hold was released: the session is free again.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
      await runtime.flush();
      expect(readStoredAttempt(dataDir, itemId)).toBeNull();
    });

    it('a preparation failure leaves a foreign witness untouched (ownership-gated unwind)', async () => {
      // The live item `enqueue` hands back is the seam: the routing hook swaps
      // in a foreign attempt record at the instant the prep failure unwinds,
      // exercising the attemptId ownership check.
      const foreign = { attemptId: 'att_foreign001', messageId: 'msg_foreign001', at: 9_999 };
      let live;
      const resolvePromptBody = async () => {
        live.consult.attempt = { ...foreign };
        throw new Error('routing hook exploded');
      };
      const { runtime, openCode } = createRuntime({ resolvePromptBody });
      runtime.start();
      openCode.state.statuses = {};
      const enqueued = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      live = enqueued.item;
      await runtime.claim(SESSION, enqueued.itemId, 'consult:run-1');

      const result = await runtime.dispatchConsult(SESSION, enqueued.itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(openCode.state.promptCalls).toBe(0);
      // The foreign record was not cleared by this dispatch's unwind (it was
      // not ours to clear), and nothing was sent.
      expect(live.consult.attempt).toEqual(foreign);
      // Per the H3 contract the prep failure still unwinds its own item and
      // hold: the item is removed from the queue and the owner hold released.
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('a preparation failure from the command route is a definite not-sent', async () => {
      // `resolveSlashCommand` reads the fake's command route: a failing read
      // (the harness's failNext hook) fails preparation before the request.
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        content: '/review src',
        text: '/review src',
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failNext = /\/command$/;

      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(openCode.state.promptCalls).toBe(0);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('an HTTP 500 without a marker stays unknown (a 5xx may have been accepted)', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.tail = [{ info: { id: 'msg-other', role: 'user' }, parts: [{ type: 'text', text: 'another client' }] }];
      openCode.state.failPromptStatusOnce = 500;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      // The tester's falsification case: a 5xx can be accepted before the
      // error surfaces, so the outcome must stay unknown.
      expect(result).toEqual({ status: 'send-failed', delivered: 'unknown' });
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
    });

    it('a connection-refused failure proves non-acceptance', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.tail = [];
      openCode.state.failPromptConnectionOnce = 'ECONNREFUSED';
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('a timeout/abort without a status or cause code stays unknown', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptNetworkOnce = true;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'unknown' });
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('the same non-marker message with a network error stays unknown', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.tail = [{ info: { id: 'msg-other', role: 'user' }, parts: [{ type: 'text', text: 'another client' }] }];
      openCode.state.failPromptNetworkOnce = true;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      // No HTTP status means acceptance cannot be disproven: never 'no'.
      expect(result).toEqual({ status: 'send-failed', delivered: 'unknown' });
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
    });

    it('an uncorrelatable acting message never becomes no from a timeout alone', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      // No textPartMetadata at all: correlation is impossible.
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({ consult: { system: 'be terse' } }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptNetworkOnce = true;
      const first = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(first).toEqual({ status: 'send-failed', delivered: 'unknown' });
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('an uncorrelatable acting message with a 5xx stays unknown', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({ consult: { system: 'be terse' } }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptStatusOnce = 500;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'unknown' });
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('an uncorrelatable acting message with a 4xx is a definite no', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({ consult: { system: 'be terse' } }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptStatusOnce = 400;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'no' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    });

    it('keeps the item, claim, hold, and witness when the failure cannot be classified (reads unreadable)', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      // Correlation is possible (a runId is present) but every marker read
      // fails: indeterminate, never a guessed removal.
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptOnce = true;
      openCode.state.failMessageReadsAfterPromptFailure = true;
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(result).toEqual({ status: 'send-failed', delivered: 'unknown' });
      // The item, the claim, the hold, and the witness survive: this is the
      // ambiguous state a later resolve has to settle. The witness is
      // server-only, so the projection shows `attempted` and the file holds it.
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(snapshot[0].attempted).toBe(true);
      expect(snapshot[0].consult).toEqual({
        system: 'be terse',
        textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } },
      });
      expect(readStoredAttempt(dataDir, itemId)).toMatchObject({ messageId: expect.stringMatching(/^msg_/) });
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
      // Re-dispatch refuses rather than re-issuing the request: no same-id retry.
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'attempt-present' });
      expect(openCode.state.promptCalls).toBe(1);
    });
  });

  describe('resolveConsult reconciliation', () => {
    const consultItem = (overrides = {}) => item({
      kind: 'consult',
      consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
      ...overrides,
    });
    const markerFor = (runId) => ({
      info: { id: 'msg-marker', role: 'user' },
      parts: [{ type: 'text', text: 'the consult', metadata: { openchamberConsultReceipt: { runID: runId } } }],
    });
    /** A runtime restored from a version-1 file: its consult item is legacy-witnessed. */
    const legacyRuntime = async ({ consult, tail = [] } = {}) => {
      const dataDir = seedQueueFile(makeDataDir(), {
        version: 1,
        items: [storedConsultItem({ consult: consult ?? { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } } })],
      });
      const harness = createRuntime({ dataDir });
      harness.runtime.start();
      harness.openCode.state.statuses = {};
      harness.openCode.state.tail = tail;
      await harness.runtime.load();
      return { ...harness, itemId: 'queued-legacy-1' };
    };

    it('a legacy witness resolves delivered from the marker: removes once, releases the claimed owner, never prompts', async () => {
      const { runtime, openCode, itemId, broadcasts } = await legacyRuntime({ tail: [markerFor('run-1')] });
      // A bystander owner keeps its hold: only the item's own owner may go
      // (the legacy item is restored unclaimed, so nothing is released).
      runtime.setHold(SESSION, true, 60_000, 'consult:bystander');

      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'dispatched', delivered: 'confirmed', evidence: 'legacy-marker' });
      // No prompt and no command was ever sent: resolution reads, never sends.
      expect(openCode.state.sent).toHaveLength(0);
      expect(openCode.fetchImpl.mock.calls.some(([, init]) => (init?.method ?? 'GET') === 'POST')).toBe(false);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(broadcasts.at(-1).properties.session.items).toEqual([]);

      // Removed exactly once: a second resolve finds nothing.
      expect(await runtime.resolveConsult(SESSION, itemId)).toEqual({ status: 'not-found' });
      // The unrelated owner's hold survived; the (absent) own owner released nothing.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:bystander')).toMatchObject({ held: false });
    });

    it('a modern witness resolves delivered on an address 200, releasing the claimed owner', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      // An ambiguous failure leaves the item claimed with a modern witness.
      openCode.state.failPromptOnce = true;
      openCode.state.failMessageReadsAfterPromptFailure = true;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const attempt = readStoredAttempt(dataDir, itemId);
      expect(attempt.messageId).toMatch(/^msg_/);
      // The address the request carried is now readable: the turn landed.
      openCode.state.messages[attempt.messageId] = { info: { id: attempt.messageId, role: 'user' }, parts: [{ type: 'text', text: 'follow up' }] };

      runtime.setHold(SESSION, true, 60_000, 'consult:bystander');
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'dispatched', delivered: 'confirmed', evidence: 'address' });
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      // Removed exactly once.
      expect(await runtime.resolveConsult(SESSION, itemId)).toEqual({ status: 'not-found' });
      // The claimed owner's hold is gone; the bystander's is not.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:bystander')).toMatchObject({ held: false });
    });

    it('a modern witness stays unresolved when the address is not readable (404 is not a never-created proof)', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptOnce = true;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const before = runtime.snapshot();
      const storedAttempt = readStoredAttempt(dataDir, itemId);

      // The fake knows no message with this id: a 404, which the probe showed
      // can also mean a landed message was deleted/reverted. Never a proof.
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'unresolved' });
      // Nothing mutated: same revision, same item, witness and claim kept.
      expect(runtime.snapshot()).toEqual(before);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(snapshot[0].attempted).toBe(true);
      // Byte-identical persisted witness: resolve never clears one.
      expect(readStoredAttempt(dataDir, itemId)).toEqual(storedAttempt);
      expect(snapshot[0].recoverable).toBeUndefined();
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
    });

    it('a modern witness stays unresolved when the address read fails (400/500), and resolve never clears the witness', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptOnce = true;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const attempt = readStoredAttempt(dataDir, itemId);
      openCode.state.failNext = /\/message\/msg_/;
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'unresolved' });
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      // Byte-identical: resolve only reads, and only a proven request
      // rejection may clear a witness.
      expect(readStoredAttempt(dataDir, itemId)).toEqual(attempt);
      expect(snapshot[0].attempted).toBe(true);
      expect(snapshot[0].recoverable).toBeUndefined();
    });

    it('resolve revalidates the attempt identity after the address read', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      // `enqueue` hands back the live queue item, which this test uses as the
      // seam to simulate a concurrent writer swapping the witness while
      // resolve awaits. There is no public route that replaces a witness
      // (dispatch refuses on one), so the guard exists exactly for this
      // out-of-band case.
      const { itemId, item: liveItem } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptOnce = true;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const attempt = readStoredAttempt(dataDir, itemId);
      // The address reads 200: without the identity re-check this stale read
      // would remove the item.
      openCode.state.messages[attempt.messageId] = { info: { id: attempt.messageId, role: 'user' }, parts: [{ type: 'text', text: 'follow up' }] };

      // Park the address read, then replace the stored attempt while resolve
      // awaits. The post-read check must refuse the stale decision.
      let releaseAddressRead;
      openCode.state.parkNext = {
        pathname: `/session/${SESSION}/message/${attempt.messageId}`,
        promise: new Promise((resolve) => { releaseAddressRead = resolve; }),
      };
      const pendingResolve = runtime.resolveConsult(SESSION, itemId);
      await waitFor(() => openCode.state.parkedAt === `/session/${SESSION}/message/${attempt.messageId}`);
      liveItem.consult.attempt = { ...attempt, attemptId: 'att_replaced01' };
      releaseAddressRead();

      expect(await pendingResolve).toEqual({ status: 'unresolved' });
      // Nothing was removed and no hold was released: the live queue state
      // decides, not the stale read.
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(snapshot[0].attempted).toBe(true);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
    });

    it('resolve revalidates the claim identity after the address read', async () => {
      const dataDir = makeDataDir();
      const { runtime, openCode } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId, item: liveItem } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      openCode.state.failPromptOnce = true;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const attempt = readStoredAttempt(dataDir, itemId);
      // The address reads 200: without the claim re-check this stale read
      // would remove the item and release the claim owner's hold.
      openCode.state.messages[attempt.messageId] = { info: { id: attempt.messageId, role: 'user' }, parts: [{ type: 'text', text: 'follow up' }] };
      const before = runtime.snapshot();
      const storedBefore = readStoredAttempt(dataDir, itemId);

      // Park the address read, then change the live claim identity while
      // resolve awaits (a same-owner re-claim, which the claim route allows).
      // The post-read check must refuse the stale decision.
      let releaseAddressRead;
      openCode.state.parkNext = {
        pathname: `/session/${SESSION}/message/${attempt.messageId}`,
        promise: new Promise((resolve) => { releaseAddressRead = resolve; }),
      };
      const pendingResolve = runtime.resolveConsult(SESSION, itemId);
      await waitFor(() => openCode.state.parkedAt === `/session/${SESSION}/message/${attempt.messageId}`);
      liveItem.claimed = { owner: 'consult:run-1', claimedAt: liveItem.claimed.claimedAt + 1 };
      releaseAddressRead();

      expect(await pendingResolve).toEqual({ status: 'unresolved' });
      // Nothing was removed and no hold was released: the changed claim (the
      // post-read state) is exactly what the re-check saw and kept, the stored
      // witness is byte-identical, and the revision never moved.
      expect(runtime.snapshot().revision).toBe(before.revision);
      expect(readStoredAttempt(dataDir, itemId)).toEqual(storedBefore);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toEqual({ owner: 'consult:run-1', claimedAt: liveItem.claimed.claimedAt });
      expect(snapshot[0].attempted).toBe(true);
    });

    it('a legacy witness without a receipt runId is unresolved, never resumable, never recoverable', async () => {
      const { runtime, itemId } = await legacyRuntime({ consult: { system: 'be terse' } });
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'unresolved' });
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toBeUndefined();
      expect(snapshot[0].recoverable).toBeUndefined();
    });

    it('a legacy witness with no marker is unresolved and never recoverable (still never tick-delivered)', async () => {
      const { runtime, openCode, emit, itemId } = await legacyRuntime({ tail: [] });
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'unresolved' });
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].recoverable).toBeUndefined();
      expect(snapshot[0].attempted).toBe(true);

      // Still a consult item: the generic tick never delivers it.
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);
    });

    it('a legacy witness stays unresolved when the marker read fails (never guesses)', async () => {
      const { runtime, openCode, itemId } = await legacyRuntime({ tail: [markerFor('run-1')] });
      openCode.state.failMessageReads = true;
      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'unresolved' });
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      // An unreadable tail is not evidence of non-delivery: no recoverable mark.
      expect(snapshot[0].recoverable).toBeUndefined();
    });

    it('a legacy witness finds a marker older than the dispatch tail with the deeper resolve limit', async () => {
      const marker = markerFor('run-1');
      const fillers = Array.from({ length: 30 }, (_, index) => ({
        info: { id: `msg-later-${index}`, role: 'user' },
        parts: [{ type: 'text', text: `later ${index}` }],
      }));
      const { runtime, openCode, itemId } = await legacyRuntime({ tail: [marker, ...fillers] });
      let observedLimit = null;
      openCode.fetchImpl.mockImplementationOnce(async (url) => {
        observedLimit = new URL(url).searchParams.get('limit');
        // Honor the requested limit the way the real tail read does.
        const limit = Number(observedLimit ?? '0') || openCode.state.tail.length;
        return Response.json(openCode.state.tail.slice(-limit));
      });

      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(observedLimit).toBe('200');
      expect(result).toEqual({ status: 'dispatched', delivered: 'confirmed', evidence: 'legacy-marker' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    });

    it('stays unresolved when a dispatch starts during the read and the stale read never clobbers it', async () => {
      // A legacy witness: its marker read is parked while the item's state
      // changes. A witnessed item cannot be re-dispatched, and the stale read
      // must not remove an item the queue no longer owns.
      const { runtime, openCode, itemId } = await legacyRuntime({ tail: [markerFor('run-1')] });
      let releaseRead;
      openCode.fetchImpl.mockImplementationOnce(() => new Promise((resolve) => {
        releaseRead = () => resolve(Response.json([markerFor('run-1')]));
      }));
      const pendingResolve = runtime.resolveConsult(SESSION, itemId);
      await settle(5);

      // A re-dispatch refuses on the witness: no same-id request can start.
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'claim-lost' });
      // The user removes the item while the read is still in flight.
      await runtime.remove(SESSION, itemId);

      releaseRead();
      expect(await pendingResolve).toEqual({ status: 'unresolved' });
      // Nothing was resurrected and no hold was touched.
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('never clears an unrelated owner-less hold when a delivered legacy item had no claim', async () => {
      const { runtime, itemId } = await legacyRuntime({ tail: [markerFor('run-1')] });
      // A legacy owner-less hold from another feature; the item itself is
      // unclaimed. Releasing the empty owner would clear that unrelated hold.
      runtime.setHold(SESSION, true, 60_000);

      const result = await runtime.resolveConsult(SESSION, itemId);
      expect(result).toEqual({ status: 'dispatched', delivered: 'confirmed', evidence: 'legacy-marker' });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      // The unrelated hold survived: only a claimed item's own owner slot is
      // released, and an unclaimed item has no owner to release.
      expect(runtime.setHold(SESSION, false, undefined, 'unrelated')).toMatchObject({ held: true });
      expect(runtime.setHold(SESSION, false)).toMatchObject({ held: false });
    });

    it('answers sending while a dispatch is in flight and touches nothing', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      let releasePrompt;
      openCode.state.parkNext = {
        pathname: `/session/${SESSION}/prompt_async`,
        promise: new Promise((resolve) => { releasePrompt = resolve; }),
      };
      const pending = runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      await waitFor(() => openCode.state.parkedAt === `/session/${SESSION}/prompt_async`);
      expect(await runtime.resolveConsult(SESSION, itemId)).toEqual({ status: 'sending' });
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      releasePrompt();
      expect((await pending).status).toBe('dispatched');
    });

    it('leaves a still-claimed item with a live hold untouched (no-witness predicate)', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const readsBefore = openCode.state.messageReadCalls;

      const result = await runtime.resolveConsult(SESSION, itemId);
      // A witnessed claim is the owner's live flow; without a witness the
      // claim itself is what makes this unresolved.
      expect(result).toEqual({ status: 'unresolved' });
      expect(openCode.state.messageReadCalls).toBe(readsBefore);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      expect(snapshot[0].recoverable).toBeUndefined();
      // The owning client may still be mid-flight: its lease survives.
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
    });

    it('answers resumable for an unclaimed item that never reached a dispatch attempt', async () => {
      const { runtime, openCode, broadcasts } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse' },
      }));
      const readsBefore = openCode.state.messageReadCalls;
      const before = runtime.snapshot();
      const broadcastsBefore = broadcasts.length;

      const result = await runtime.resolveConsult(SESSION, itemId);
      // No witness means no dispatch pre-send step ever ran, so no prompt for
      // this item can have been sent: provably resumable, not merely unknown.
      expect(result).toEqual({ status: 'resumable' });
      // No tail read and no marker fetch at all.
      expect(openCode.state.messageReadCalls).toBe(readsBefore);
      // The never-attempted proof stamps the item back into the normal
      // recoverable state (one commit: the revision moves and the change
      // broadcasts), so the Resume affordance exists without a restart.
      expect(runtime.snapshot().revision).toBeGreaterThan(before.revision);
      expect(broadcasts.length).toBeGreaterThan(broadcastsBefore);
      expect(broadcasts.at(-1).properties.revision).toBe(runtime.snapshot().revision);
      expect(broadcasts.at(-1).properties.session.items[0].recoverable).toBe(true);
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toBeUndefined();
      expect(snapshot[0].recoverable).toBe(true);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(false);
    });

    it('answers not-found and not-consult like the dispatch entry order', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      expect(await runtime.resolveConsult(SESSION, 'missing')).toEqual({ status: 'not-found' });
      const normal = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      expect(await runtime.resolveConsult(SESSION, normal.itemId)).toEqual({ status: 'not-consult' });
    });
  });

  describe('expiry sweep and restart revert', () => {
    const consultItem = (overrides = {}) => item({ kind: 'consult', consult: { system: 'be terse' }, ...overrides });

    it('a lapsed reservation keeps the consult item a consult item and it is never tick-delivered', async () => {
      let clock = 0;
      const { runtime, openCode, emit } = createRuntime({ now: () => clock });
      runtime.start();
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      openCode.state.statuses = {};
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);
      expect(runtime.sessionSnapshot(SESSION).items[0].kind).toBe('consult');

      // The reservation lapses; a hold mutation sweeps the claim away, but the
      // consult intent survives: the kind stays, only claim and payload go.
      clock = 2_000;
      runtime.setHold('ses_other_sweep', true, 60_000, 'other');
      const cleared = runtime.sessionSnapshot(SESSION).items[0];
      expect(cleared.kind).toBe('consult');
      expect(cleared).not.toHaveProperty('claimed');
      expect(cleared).not.toHaveProperty('consult');
      // The lapsed reservation marks the item recoverable: a client may resume
      // (re-claim) it or the user may remove it; it is never raw-sent.
      expect(cleared.recoverable).toBe(true);
      expect(cleared.content).toBe('follow up');

      // The stale consult item still blocks the queue: the tick sends nothing,
      // not even the normal item queued behind it.
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['follow up', 'plain']);
    });

    it('a lapsed reservation drops the stale system but keeps the receipt metadata (delivery identity)', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      const metadata = { openchamberConsultReceipt: { runID: 'run-1' } };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: metadata },
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);

      clock = 2_000;
      runtime.setHold('ses_other_lapse_identity', true, 60_000, 'other');
      const cleared = runtime.sessionSnapshot(SESSION).items[0];
      expect(cleared.recoverable).toBe(true);
      expect(cleared).not.toHaveProperty('claimed');
      // The stale synthesis must never be re-sent, but the receipt metadata is
      // the run's delivery-correlation identity: a later Resume re-checks
      // delivery with it before re-fanning-out the acting turn.
      expect(cleared.consult).toEqual({ textPartMetadata: metadata });
    });

    it('take refuses a consult item and takeAll skips it', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const consult = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      const normal = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));

      await expect(runtime.take(SESSION, consult.itemId)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('consult-item'),
      });
      const all = await runtime.takeAll(SESSION);
      expect(all.items.map((entry) => entry.id)).toEqual([normal.itemId]);
      // The consult item stays queued; the normal item was taken.
      expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.id)).toEqual([consult.itemId]);
    });

    it('a restart restores a consult item as an unclaimed consult item and tick does not deliver it', async () => {
      const dataDir = makeDataDir();
      const first = createRuntime({ dataDir });
      first.runtime.start();
      const { itemId } = await first.runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await first.runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      await first.runtime.flush();
      first.runtime.stop();

      const second = createRuntime({ dataDir });
      second.runtime.start();
      await second.runtime.load();
      const loaded = second.runtime.sessionSnapshot(SESSION).items[0];
      expect(loaded.content).toBe('follow up');
      expect(loaded.kind).toBe('consult');
      expect(loaded).not.toHaveProperty('consult');
      expect(loaded).not.toHaveProperty('claimed');

      second.connect();
      await settle();
      expect(second.openCode.state.sent).toHaveLength(0);
      expect(second.runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('a restart restores a previously-claimed consult item recoverable and never tick-delivers it', async () => {
      const dataDir = makeDataDir();
      const first = createRuntime({ dataDir });
      first.runtime.start();
      const { itemId } = await first.runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await first.runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      await first.runtime.flush();
      first.runtime.stop();

      const second = createRuntime({ dataDir });
      second.runtime.start();
      await second.runtime.load();
      const loaded = second.runtime.sessionSnapshot(SESSION).items[0];
      expect(loaded.kind).toBe('consult');
      expect(loaded).not.toHaveProperty('claimed');
      expect(loaded).not.toHaveProperty('consult');
      // A reservation cannot survive the restart: the restored item is
      // recoverable, exactly like a lapsed one.
      expect(loaded.recoverable).toBe(true);

      second.connect();
      await settle();
      expect(second.openCode.state.sent).toHaveLength(0);
      expect(second.runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('a restart keeps the restored consult item\'s receipt metadata as its delivery identity', async () => {
      const dataDir = makeDataDir();
      const metadata = { openchamberConsultReceipt: { runID: 'run-1' } };
      const first = createRuntime({ dataDir });
      first.runtime.start();
      const { itemId } = await first.runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', textPartMetadata: metadata },
      }));
      await first.runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      await first.runtime.flush();
      first.runtime.stop();

      const second = createRuntime({ dataDir });
      second.runtime.start();
      await second.runtime.load();
      const loaded = second.runtime.sessionSnapshot(SESSION).items[0];
      expect(loaded.recoverable).toBe(true);
      expect(loaded).not.toHaveProperty('claimed');
      // Holds are memory-only, so the reservation is gone; the stale synthesis
      // is dropped, but the receipt metadata survives so a Resume can check
      // whether the pre-restart dispatch already landed.
      expect(loaded.consult).toEqual({ textPartMetadata: metadata });
    });

    it('a fresh owner re-claims a lapsed head consult item and dispatches it as today', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);
      clock = 2_000;
      // The sweep marks the item recoverable: it has no witness, so no
      // dispatch attempt can exist for it.
      expect(runtime.sessionSnapshot(SESSION).items[0].recoverable).toBe(true);
      expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('attempted');

      // A fresh owner claims the recoverable head item; the payload route and
      // the dispatch route work exactly as for a first claim.
      const result = await runtime.claim(SESSION, itemId, 'consult:run-2', 60_000);
      expect(result.claimed).toBe(true);
      expect(result.item.claimed).toMatchObject({ owner: 'consult:run-2' });
      // The re-claim cleared the recovery marker (no flag on the claimed item).
      expect(result.item).not.toHaveProperty('recoverable');
      await runtime.setConsultPayload(SESSION, itemId, 'consult:run-2', { system: 'resumed' });
      const dispatched = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-2');
      expect(dispatched.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
      expect(openCode.state.sent[0].body.system).toBe('resumed');
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    });

    it('a witnessed lapsed item refuses a re-claim and is never marked recoverable', async () => {
      let clock = 0;
      const { runtime, openCode } = createRuntime({ now: () => clock });
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1', 1_000);
      // The dispatch writes the witness and then fails ambiguously; the item
      // keeps item, claim, hold, and witness.
      openCode.state.failPromptStatusOnce = 500;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const attempt = runtime.sessionSnapshot(SESSION).items[0].attempted;
      expect(attempt).toBe(true);

      // The dispatch extended the owner hold to the cap, so the lapse needs to
      // pass 10 minutes.
      clock = 700_000;
      runtime.setHold('ses_other_witnessed_lapse', true, 60_000, 'other');
      const cleared = runtime.sessionSnapshot(SESSION).items[0];
      // The claim lapsed, the stale synthesis is gone, but the witness keeps
      // the item out of the resume path: no recoverable, no re-claim.
      expect(cleared).not.toHaveProperty('claimed');
      expect(cleared.recoverable).toBeUndefined();
      expect(cleared.attempted).toBe(true);
      await expect(runtime.claim(SESSION, itemId, 'consult:run-2', 60_000)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('attempt-recorded'),
      });
      // Still queued and still a consult item: it keeps blocking the head.
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('a live or successfully dispatched claim never leaves the item recoverable', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      // While the hold is live the item is a normal reservation, not a recovery.
      expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('recoverable');
      // A successful dispatch removes the item entirely; had it stayed, it must
      // not be marked recoverable by the release path.
      const dispatched = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(dispatched.status).toBe('dispatched');
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(openCode.state.sent).toHaveLength(1);
    });

    it('re-claim refusals stay unchanged: claimed-by-other, not-head, busy', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.enqueue(SESSION, DIRECTORY, consultItem({ content: 'second consult', text: 'second consult' }));
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      // claimed-by-other (re-claim still requires an unclaimed item or its owner).
      await expect(runtime.claim(SESSION, itemId, 'consult:run-2', 60_000)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('already-claimed'),
      });
      // not-head: the second consult item sits behind the claimed head.
      const second = runtime.sessionSnapshot(SESSION).items[1].id;
      await expect(runtime.claim(SESSION, second, 'consult:run-2', 60_000)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-head'),
      });
      // busy (not-idle): the same owner may re-claim, but not while busy.
      openCode.state.statuses = { [SESSION]: { type: 'busy' } };
      await expect(runtime.claim(SESSION, itemId, 'consult:run-1', 60_000)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('not-idle'),
      });
    });

    it('claim refuses attempt-recorded at entry and after the idle await, and never writes or clears a witness', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);

      // Park the same-owner re-claim on its status read, then let a dispatch of
      // that item write the witness while the claim is still awaiting.
      let releaseStatusRead;
      openCode.state.parkNext = {
        pathname: '/session/status',
        promise: new Promise((resolve) => { releaseStatusRead = resolve; }),
      };
      const pendingClaim = runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      await waitFor(() => openCode.state.parkedAt === '/session/status');

      openCode.state.failPromptStatusOnce = 500;
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
      const witnessed = runtime.sessionSnapshot(SESSION).items[0];
      expect(witnessed.attempted).toBe(true);

      releaseStatusRead();
      // The attempt appeared after the entry check: the post-await re-check
      // must refuse rather than cash in a claim whose dispatch could duplicate
      // a turn.
      await expect(pendingClaim).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('attempt-recorded'),
      });

      // Entry refusal, and neither refusal touched the witness: it is
      // byte-identical and the reservation is exactly the dispatch's.
      await expect(runtime.claim(SESSION, itemId, 'consult:run-1', 60_000)).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining('attempt-recorded'),
      });
      expect(runtime.sessionSnapshot(SESSION).items[0].attempted).toBe(true);
      expect(runtime.hasActiveConsultReservation(SESSION)).toBe(true);
    });

    it('claim never writes or clears a witness when it claims an unwitnessed item', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      const result = await runtime.claim(SESSION, itemId, 'consult:run-1', 60_000);
      expect(result.claimed).toBe(true);
      // The claim writes its own reservation only; the attempt field is absent.
      expect(runtime.sessionSnapshot(SESSION).items[0].consult).toEqual({ system: 'be terse' });
      expect(runtime.sessionSnapshot(SESSION).items[0].consult).not.toHaveProperty('attempt');
    });

    it('snapshot projection includes recoverable only for consult items', async () => {
      let clock = 0;
      const { runtime } = createRuntime({ now: () => clock });
      runtime.start();
      // A consult item can only be claimed at the head, so it goes first.
      await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'after', text: 'after' }));
      // A normal item never carries the field.
      expect(runtime.sessionSnapshot(SESSION).items[1]).not.toHaveProperty('recoverable');
      expect(runtime.sessionSnapshot(SESSION).items[2]).not.toHaveProperty('recoverable');
      // The head consult item starts clean while its claim holds.
      await runtime.claim(SESSION, runtime.sessionSnapshot(SESSION).items[0].id, 'consult:run-1', 1_000);
      expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('recoverable');
      // After the hold lapses only the lapsed consult item carries recoverable.
      clock = 2_000;
      runtime.setHold('ses_other_projection', true, 60_000, 'other');
      expect(runtime.sessionSnapshot(SESSION).items[0].recoverable).toBe(true);
      expect(runtime.sessionSnapshot(SESSION).items[1]).not.toHaveProperty('recoverable');
      expect(runtime.sessionSnapshot(SESSION).items[2]).not.toHaveProperty('recoverable');
    });

    it('an explicit remove deletes a consult item and lets normal items flow', async () => {
      const { runtime, openCode, emit } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const consult = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));

      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);

      await runtime.remove(SESSION, consult.itemId);
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(1);
      expect(openCode.state.sent[0].body.parts).toEqual([{ type: 'text', text: 'plain' }]);
    });

    it('a version-1 file gives every consult item a legacy witness, including the bare conservative case', async () => {
      // The bare item has no claim and no consult payload at all: the old
      // build's fire-and-forget persist means that still is not proof that no
      // dispatch was attempted, so it must be restored as legacy-witnessed.
      const dataDir = seedQueueFile(makeDataDir(), {
        version: 1,
        items: [storedConsultItem({ consult: undefined })],
      });
      const { runtime, openCode, emit } = createRuntime({ dataDir });
      runtime.start();
      openCode.state.statuses = {};
      await runtime.load();

      const restored = runtime.sessionSnapshot(SESSION).items[0];
      expect(restored.attempted).toBe(true);
      // The witness withholds the recovery marker even though the item has no
      // claim and no payload.
      expect(restored.recoverable).toBeUndefined();
      // A sweep pass must not resurrect a resume either.
      runtime.setHold('ses_other_v1_bare', true, 60_000, 'other');
      expect(runtime.sessionSnapshot(SESSION).items[0].recoverable).toBeUndefined();

      // Resolve answers unknown, never resumable.
      expect(await runtime.resolveConsult(SESSION, 'queued-legacy-1')).toEqual({ status: 'unresolved' });
      // Still never delivered raw by the tick.
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.sessionSnapshot(SESSION).items).toHaveLength(1);
    });

    it('a file with a version above the known one is moved aside like malformed data', async () => {
      const dataDir = makeDataDir();
      seedQueueFile(dataDir, { version: 99, items: [storedConsultItem()] });
      const { runtime } = createRuntime({ dataDir });
      runtime.start();
      await runtime.load();

      // The bytes are kept for the user, the runtime starts empty, and the
      // next write cannot overwrite the unknown-version file.
      expect(runtime.snapshot().sessions).toEqual([]);
      const backups = fs.readdirSync(dataDir).filter((name) => name.startsWith('message-queue.json.corrupt-'));
      expect(backups).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(path.join(dataDir, backups[0]), 'utf8')).version).toBe(99);
    });

    it('enqueue and the payload merge strip a client-supplied attempt', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const forged = { attemptId: 'att_forged0001', messageId: 'msg_forged0001', at: 1 };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        consult: { system: 'be terse', attempt: forged },
      }));
      // The stored item has no witness: the client cannot fabricate one, so
      // the item is still claimable and resumable.
      expect(runtime.sessionSnapshot(SESSION).items[0].consult).not.toHaveProperty('attempt');
      expect(await runtime.resolveConsult(SESSION, itemId)).toEqual({ status: 'resumable' });

      await runtime.claim(SESSION, itemId, 'consult:run-1');
      await runtime.setConsultPayload(SESSION, itemId, 'consult:run-1', {
        system: 'updated',
        attempt: forged,
      });
      // The merge copies the payload fields only; the forged attempt is gone.
      const merged = runtime.sessionSnapshot(SESSION).items[0].consult;
      expect(merged).toEqual({ system: 'updated' });
      expect(merged).not.toHaveProperty('attempt');
      // A dispatch therefore mints its own server witness, not the forged one.
      const dispatched = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(dispatched.status).toBe('dispatched');
      expect(openCode.state.sent[0].body.messageID).toMatch(/^msg_/);
      expect(openCode.state.sent[0].body.messageID).not.toBe(forged.messageId);
    });
  });

  it('drops the queue of a deleted session', async () => {
    const { runtime, emit, broadcasts } = createRuntime();
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item());
    emit({ type: 'session.deleted', properties: { info: { id: SESSION } } });
    expect(runtime.snapshot().sessions).toEqual([]);
    expect(broadcasts.at(-1).properties.session).toMatchObject({ sessionId: SESSION, items: [] });
  });

  it('dispatches a queued slash command through the command endpoint', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({ content: '/review src', text: '/review src', sendConfig: { providerID: 'p', modelID: 'm', agent: 'build', variant: 'max' } }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent).toHaveLength(1);
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body).toEqual({ command: 'review', arguments: 'src', model: 'p/m', agent: 'build', variant: 'max' });
  });

  it('delivers captured context as synthetic parts, instructions first, before project knowledge', async () => {
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async () => {},
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    const metadata = { openchamberContext: { kind: 'github-pr', number: 7, title: 'PR', url: 'https://x/pr/7' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      agentMention: 'reviewer',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
      context: [
        { kind: 'context', text: 'the diff', metadata, instructions: 'how to read it' },
        { kind: 'synthetic', text: 'conflict payload' },
        { kind: 'instruction', text: 'use the skill' },
      ],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'follow up' },
      { type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' },
      { type: 'text', text: 'how to read it', synthetic: true },
      { type: 'text', text: 'the diff', synthetic: true, metadata },
      { type: 'text', text: 'conflict payload', synthetic: true },
      { type: 'text', text: 'use the skill', synthetic: true },
      { type: 'text', text: 'pinned notes', synthetic: true },
      { type: 'agent', name: 'reviewer' },
    ]);
  });

  it('keeps files on the command route, which is all that route accepts', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review',
      text: '/review',
      attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/command`);
    expect(openCode.state.sent[0].body.parts).toEqual([{ type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' }]);
  });

  it('sends a command queued with context as its expanded prompt, context included', async () => {
    // The command route rejects text parts, so a command with captured
    // context takes the prompt route with the template expanded, exactly as
    // the composer does.
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'review', source: 'command', template: 'Review $1 with focus on $2' }];
    const metadata = { openchamberContext: { kind: 'chat-quote', quote: 'q', text: 'why?' } };
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/review src "error handling"',
      text: '/review src "error handling"',
      context: [{ kind: 'context', text: 'quoted', metadata }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'Review src with focus on error handling' },
      { type: 'text', text: 'quoted', synthetic: true, metadata },
    ]);
  });

  it('sends a skill queued with context as an explicit invocation, context included', async () => {
    const { runtime, openCode, emit } = createRuntime();
    runtime.start();
    openCode.state.commands = [{ name: 'grill', source: 'skill', template: 'skill body' }];
    await runtime.enqueue(SESSION, DIRECTORY, item({
      content: '/grill auth',
      text: '/grill auth',
      context: [{ kind: 'synthetic', text: 'focus on tests' }],
    }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].path).toBe(`/session/${SESSION}/prompt_async`);
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: '/grill auth' },
      { type: 'text', text: 'focus on tests', synthetic: true },
      { type: 'text', text: 'The user explicitly invoked the grill skill. Use the corresponding skill tool to handle this request.', synthetic: true },
    ]);
  });

  it('keeps captured context out of snapshots and broadcasts, and hands it back on take', async () => {
    const { runtime, broadcasts } = createRuntime();
    runtime.start();
    const context = [{ kind: 'synthetic', text: 'a large diff' }];
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, item({ context }));
    expect(runtime.sessionSnapshot(SESSION).items[0]).not.toHaveProperty('context');
    expect(runtime.sessionSnapshot(SESSION).items[0].text).toBe('follow up');
    expect(broadcasts.at(-1).properties.session.items[0]).not.toHaveProperty('context');
    const taken = await runtime.take(SESSION, itemId);
    expect(taken.item.context).toEqual(context);
  });

  it('attaches pending project knowledge and records its delivery', async () => {
    const recorded = [];
    const knowledge = {
      resolvePendingForSession: async () => ({ text: 'pinned notes', signature: 'sig-1' }),
      recordDelivered: async (sessionId, directory, signature) => { recorded.push({ sessionId, directory, signature }); },
    };
    const { runtime, openCode, emit } = createRuntime({ knowledge });
    runtime.start();
    await runtime.enqueue(SESSION, DIRECTORY, item({ agentMention: 'reviewer', attachments: [{ id: 'a', filename: 'f.txt', mimeType: 'text/plain', size: 1, source: 'local', dataUrl: 'data:text/plain,hi' }] }));
    emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
    await settle();
    expect(openCode.state.sent[0].body.parts).toEqual([
      { type: 'text', text: 'follow up' },
      { type: 'file', mime: 'text/plain', filename: 'f.txt', url: 'data:text/plain,hi' },
      { type: 'text', text: 'pinned notes', synthetic: true },
      { type: 'agent', name: 'reviewer' },
    ]);
    expect(recorded).toEqual([{ sessionId: SESSION, directory: DIRECTORY, signature: 'sig-1' }]);
  });
});

/**
 * A minimal Express stand-in: routes are collected by method + path and can
 * be invoked with plain request/response recorders. It exists so the route
 * layer itself is exercised (the maintainer's payload-await defect slipped
 * through runtime-level tests).
 */
const createFakeApp = () => {
  const handlers = new Map();
  const record = (method) => (path, handler) => {
    handlers.set(`${method} ${path}`, handler);
  };
  return {
    get: record('GET'),
    post: record('POST'),
    put: record('PUT'),
    delete: record('DELETE'),
    call: async (method, path, { params = {}, body } = {}) => {
      const handler = handlers.get(`${method} ${path}`);
      if (!handler) throw new Error(`no route for ${method} ${path}`);
      const result = { status: null, body: undefined, settled: false };
      const res = {
        status(code) {
          result.status = code;
          return this;
        },
        json(payload) {
          // Reject a promise passed through by mistake: res.json must receive
          // the resolved value, never the pending runtime call.
          if (payload instanceof Promise) {
            throw new Error('res.json received a promise');
          }
          result.body = payload;
          result.settled = true;
          return this;
        },
      };
      await handler({ params, body, query: {}, headers: {} }, res);
      return result;
    },
  };
};

describe('message queue routes', () => {
  const consultItem = (overrides = {}) => item({ kind: 'consult', consult: { system: 'be terse' }, ...overrides });

  const routeSetup = async ({ dataDir } = {}) => {
    const harness = createRuntime(dataDir ? { dataDir } : {});
    harness.runtime.start();
    const app = createFakeApp();
    registerMessageQueueRoutes(app, harness.runtime);
    return { ...harness, app };
  };

  it('awaits the payload mutation before responding and merges the payload', async () => {
    const { runtime, openCode, app } = await routeSetup();
    openCode.state.statuses = {};
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
    await runtime.claim(SESSION, itemId, 'consult:run-1');

    const response = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/payload', {
      params: { sessionId: SESSION, itemId },
      body: { owner: 'consult:run-1', consult: { system: 'payloaded' } },
    });

    expect(response.settled).toBe(true);
    expect(response.body).toMatchObject({ ok: true, item: { id: itemId, consult: { system: 'payloaded' } } });
    // The response never outran the mutation.
    expect(runtime.sessionSnapshot(SESSION).items[0].consult).toEqual({ system: 'payloaded' });
  });

  it('maps a foreign-owner payload refusal to a 4xx JSON error', async () => {
    const { runtime, openCode, app } = await routeSetup();
    openCode.state.statuses = {};
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
    await runtime.claim(SESSION, itemId, 'consult:run-1');

    const response = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/payload', {
      params: { sessionId: SESSION, itemId },
      body: { owner: 'consult:other', consult: { system: 'nope' } },
    });

    expect(response.status).toBe(409);
    expect(response.body?.error).toContain('not-claiming');
    expect(runtime.sessionSnapshot(SESSION).items[0].consult).toEqual({ system: 'be terse' });
  });

  it('serves the claim route with the claimed item and a refusal status', async () => {
    const { runtime, openCode, app } = await routeSetup();
    openCode.state.statuses = {};
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());

    const claimed = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/claim', {
      params: { sessionId: SESSION, itemId },
      body: { owner: 'consult:run-1', ttlMs: 60_000 },
    });
    expect(claimed.settled).toBe(true);
    expect(claimed.body).toMatchObject({ claimed: true, item: { id: itemId, claimed: { owner: 'consult:run-1' } } });

    const refused = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/claim', {
      params: { sessionId: SESSION, itemId },
      body: { owner: 'consult:other' },
    });
    expect(refused.status).toBe(409);
    expect(refused.body?.error).toContain('already-claimed');
  });

  it('serves the dispatch-consult route with the structured outcome', async () => {
    const { runtime, openCode, app } = await routeSetup();
    openCode.state.statuses = {};
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
    await runtime.claim(SESSION, itemId, 'consult:run-1');

    const dispatched = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/dispatch-consult', {
      params: { sessionId: SESSION, itemId },
      body: { owner: 'consult:run-1' },
    });
    expect(dispatched.status).toBeNull();
    expect(dispatched.body).toMatchObject({ status: 'dispatched', item: { id: itemId } });

    const missing = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/dispatch-consult', {
      params: { sessionId: SESSION, itemId: 'queued-missing' },
      body: { owner: 'consult:run-1' },
    });
    expect(missing.body).toEqual({ status: 'not-found' });
  });

  it('serves the resolve-consult route with the structured outcome and wraps errors', async () => {
    const dataDir = makeDataDir();
    const { runtime, openCode, app } = await routeSetup({ dataDir });
    openCode.state.statuses = {};
    const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
      consult: { system: 'be terse', textPartMetadata: { openchamberConsultReceipt: { runID: 'run-1' } } },
    }));
    await runtime.claim(SESSION, itemId, 'consult:run-1');
    // An ambiguous dispatch leaves a modern witness; its address then reads 200.
    openCode.state.failPromptOnce = true;
    openCode.state.failMessageReadsAfterPromptFailure = true;
    expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'send-failed', delivered: 'unknown' });
    const attempt = readStoredAttempt(dataDir, itemId);
    openCode.state.messages[attempt.messageId] = { info: { id: attempt.messageId, role: 'user' }, parts: [{ type: 'text', text: 'follow up' }] };

    const resolved = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/resolve-consult', {
      params: { sessionId: SESSION, itemId },
    });
    expect(resolved.status).toBeNull();
    expect(resolved.body).toEqual({ status: 'dispatched', delivered: 'confirmed', evidence: 'address' });
    expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
    // The route never prompts: the only prompt request was the ambiguous dispatch.
    expect(openCode.state.promptCalls).toBe(1);

    const notConsult = await runtime.enqueue(SESSION, DIRECTORY, item({ content: 'plain', text: 'plain' }));
    const refused = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/resolve-consult', {
      params: { sessionId: SESSION, itemId: notConsult.itemId },
    });
    expect(refused.body).toEqual({ status: 'not-consult' });

    // An unclaimed item with no witness is provably resumable: the route
    // serves the new status as a 200 structured outcome.
    const neverPayload = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
    const resumable = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/resolve-consult', {
      params: { sessionId: SESSION, itemId: neverPayload.itemId },
    });
    expect(resumable.status).toBeNull();
    expect(resumable.body).toEqual({ status: 'resumable' });

    // An invalid session id is an unexpected error at the route layer
    // (requireSessionId throws a bare TypeError), wrapped like the others' 400.
    const failed = await app.call('POST', '/api/message-queue/sessions/:sessionId/items/:itemId/resolve-consult', {
      params: { sessionId: 'bad id!', itemId },
    });
    expect(failed.status).toBe(400);
    expect(failed.body?.error).toContain('sessionId is invalid');
  });
});
