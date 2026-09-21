import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMessageQueueRuntime, parseQueuedItemInput, registerMessageQueueRoutes } from './runtime.js';

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
  };
  const fetchImpl = vi.fn(async (url, init = {}) => {
    const { pathname } = new URL(url);
    const method = init.method ?? 'GET';
    if (state.failNext && state.failNext.test(pathname)) {
      state.failNext = null;
      return new Response('boom', { status: 500 });
    }
    if (pathname === '/session/status') return Response.json(state.statuses);
    if (pathname.endsWith('/message')) {
      state.messageReadCalls += 1;
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

const createRuntime = ({ dataDir = makeDataDir(), openCode = createOpenCode(), knowledge = null, retryDelayMs, resolvePromptBody, now } = {}) => {
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
      expect(result.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
      const body = openCode.state.sent[0].body;
      expect(body.system).toBe('be terse');
      expect(body.parts[0]).toEqual({
        type: 'text',
        text: 'follow up',
        metadata: { openchamberConsult: { model: 'glm-4.7' } },
      });
      expect(runtime.sessionSnapshot(SESSION).items).toEqual([]);
      expect(broadcasts.at(-1).properties.session.items).toEqual([]);
      // The owner hold was released: a later normal dispatch is possible.
      expect(runtime.setHold(SESSION, false, undefined, 'consult:run-1')).toMatchObject({ held: false });
    });

    it('an attachment-only consult dispatches with metadata on no part', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const attachment = { id: 'a1', filename: 'shot.png', mimeType: 'image/png', size: 3, source: 'local', dataUrl: 'data:image/png;base64,AAA=' };
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem({
        content: '',
        text: '',
        attachments: [attachment],
      }));
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      const result = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');

      expect(result.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
      const parts = openCode.state.sent[0].body.parts;
      expect(parts).toEqual([{ type: 'file', mime: 'image/png', filename: 'shot.png', url: attachment.dataUrl }]);
      // A file part has no metadata field: the receipt is deliberately absent.
      expect(parts.some((part) => 'metadata' in part)).toBe(false);
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

    it('answers sending while a dispatch is in flight and keeps the item and claim', async () => {
      const { runtime, openCode } = createRuntime();
      runtime.start();
      openCode.state.statuses = {};
      const { itemId } = await runtime.enqueue(SESSION, DIRECTORY, consultItem());
      await runtime.claim(SESSION, itemId, 'consult:run-1');
      let releasePrompt;
      openCode.fetchImpl.mockImplementationOnce(async () => Response.json({}))
        .mockImplementationOnce(async () => Response.json([]))
        .mockImplementationOnce(() => new Promise((resolve) => {
          releasePrompt = () => resolve(new Response(null, { status: 204 }));
        }));
      const pending = runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      await settle(5);
      expect(await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1')).toEqual({ status: 'sending' });
      expect(runtime.sessionSnapshot(SESSION).items[0].claimed).toMatchObject({ owner: 'consult:run-1' });
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

    it('keeps the item, claim, and hold when the failure cannot be classified (tail unreadable)', async () => {
      const { runtime, openCode } = createRuntime();
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
      // The item, the claim, and the hold survive: a retry dispatches cleanly.
      const snapshot = runtime.sessionSnapshot(SESSION).items;
      expect(snapshot).toHaveLength(1);
      expect(snapshot[0].claimed).toMatchObject({ owner: 'consult:run-1' });
      openCode.state.failMessageReads = false;
      const retry = await runtime.dispatchConsult(SESSION, itemId, 'consult:run-1');
      expect(retry.status).toBe('dispatched');
      expect(openCode.state.sent).toHaveLength(1);
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
      expect(cleared.content).toBe('follow up');

      // The stale consult item still blocks the queue: the tick sends nothing,
      // not even the normal item queued behind it.
      emit({ type: 'session.status', properties: { sessionID: SESSION, status: { type: 'idle' } } });
      await settle();
      expect(openCode.state.sent).toHaveLength(0);
      expect(runtime.sessionSnapshot(SESSION).items.map((entry) => entry.content)).toEqual(['follow up', 'plain']);
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

  const routeSetup = async () => {
    const harness = createRuntime();
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
});
