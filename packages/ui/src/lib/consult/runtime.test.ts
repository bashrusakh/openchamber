import { describe, expect, test } from 'bun:test';
import type { Agent, Message, Part, PermissionRuleset, Provider, Session } from '@opencode-ai/sdk/v2';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import type { ConsultMessageRecord } from './completion';
import { CONSULT_ADVISOR_SYSTEM_PROMPT } from './prompts';
import {
  CONSULT_ADVISOR_PERMISSION,
  ConsultationRefusedError,
  createConsultRunRegistry,
  createConsultRuntime,
  type ConsultAdvisorSendParams,
  type ConsultationResult,
  type ConsultRuntimeDeps,
  type StartConsultationInput,
} from './runtime';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

const deferred = <T>(): Deferred<T> => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};

const sessionFixture = (id: string, directory = '/work'): Session => ({
  id,
  slug: id,
  projectID: 'project-1',
  directory,
  title: id,
  version: '1.18.31',
  time: { created: 0, updated: 0 },
});

const userMessage = (id: string): Message => ({
  id,
  sessionID: 'parent',
  role: 'user',
  time: { created: 1 },
  agent: 'build',
  model: { providerID: 'anthropic', modelID: 'claude' },
});

const assistantMessage = (id: string, completed: number | undefined): Message => {
  // SAFETY: the runtime only reads role and time.completed from parent messages
  // and the completion reader reads role/time/error; other fields are unused.
  return { id, sessionID: 'parent', role: 'assistant', time: { created: 1, completed } } as Message;
};

const failedAssistantMessage = (id: string, message: string): Message => {
  // SAFETY: the completion reader reads only the error's name and data.message.
  return {
    id,
    sessionID: 'parent',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    error: { name: 'UnknownError', data: { message } },
  } as Message;
};

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}-text`,
  sessionID: 'parent',
  messageID,
  type: 'text',
  text,
});

const record = (info: Message, parts: Part[] = []): ConsultMessageRecord => ({ info, parts });

const providerModel = (id: string, variants?: Record<string, string>): Provider['models'][string] => {
  // SAFETY: validation reads only `id` and `variants`; the remaining Model
  // fields are server-owned data the runtime never touches.
  return { id, variants } as Provider['models'][string];
};

const provider = (id: string, models: Provider['models']): Provider => ({
  id,
  name: id,
  source: 'config',
  env: [],
  options: {},
  models,
});

const agent = (name: string, mode: Agent['mode']): Agent => ({
  name,
  mode,
  permission: [],
  options: {},
});

const selection = (overrides?: Partial<StartConsultationInput['advisors'][number]>) => ({
  providerID: 'anthropic',
  modelID: 'claude',
  variant: 'high',
  agent: 'build',
  ...overrides,
});

const baseInput = (overrides?: Partial<StartConsultationInput>): StartConsultationInput => ({
  parentSessionId: 'parent',
  directory: '/work',
  advisors: [selection()],
  messageText: 'What should we do next?',
  attachments: [{ type: 'file', mime: 'image/png', filename: 'shot.png', url: 'data:image/png;base64,abc' }],
  timeoutMs: 30,
  ...overrides,
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

type ForkCall = { sessionId: string; messageId: string | undefined; directory: string };

type ReplyScript =
  | { kind: 'completed'; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }
  | { kind: 'unfinished' }
  | { kind: 'read-error' }
  | { kind: 'deferred'; deferred: Deferred<readonly ConsultMessageRecord[]> };

type HarnessState = {
  calls: string[];
  forkCalls: ForkCall[];
  pendingForks: Array<{ gate: Deferred<Session>; session: Session }>;
  holdForks: boolean;
  forkFailures: Map<number, Error>;
  surfaceError: Error | null;
  sent: ConsultAdvisorSendParams[];
  updated: Array<{ id: string; patch: { permission: PermissionRuleset }; directory: string }>;
  metadataPatches: Array<{ id: string; directory: string | null | undefined; expectedRuntimeKey: string | undefined; metadata: SessionMetadataRecord }>;
  patchFailures: Set<string>;
  registeredDirectories: Array<{ id: string; directory: string }>;
  aborted: string[];
  deleted: Array<{ id: string; directory: string; expectedRuntimeKey: string | undefined }>;
  deleteFailures: Set<string>;
  holdReleases: Array<{ sessionId: string; owner: string }>;
  pendingHidden: Set<string>;
  parentMessages: Message[];
  providers: Provider[];
  agents: Agent[];
  runtimeKey: string;
  replies: Map<string, ReplyScript>;
  /** Per-fork permission read-back control for the F3 verification tests. */
  permissionReadbacks: Map<string, 'echo' | 'echo-absent' | 'refetch-present' | 'wrong-rule' | 'throw'>;
  readbacks: number;
  now: number;
  runCounter: number;
};

type Harness = {
  runtime: ReturnType<typeof createConsultRuntime>;
  registry: ReturnType<typeof createConsultRunRegistry>;
  state: HarnessState;
  releaseForks: () => void;
  flush: () => Promise<void>;
};

const replyRecords = (script: ReplyScript, forkId: string): readonly ConsultMessageRecord[] => {
  const user = userMessage(`${forkId}-user`);
  switch (script.kind) {
    case 'completed':
      return [record(user), record(assistantMessage(`${forkId}-reply`, 2), [textPart(`${forkId}-reply`, script.text)])];
    case 'empty':
      return [record(user), record(assistantMessage(`${forkId}-reply`, 2))];
    case 'error':
      return [record(user), record(failedAssistantMessage(`${forkId}-reply`, script.message))];
    case 'unfinished':
      return [record(user), record(assistantMessage(`${forkId}-reply`, undefined), [textPart(`${forkId}-reply`, 'partial')])];
    case 'read-error':
      return [];
    case 'deferred':
      return [];
  }
};

const createHarness = (): Harness => {
  const state: HarnessState = {
    calls: [],
    forkCalls: [],
    pendingForks: [],
    holdForks: false,
    forkFailures: new Map(),
    surfaceError: null,
    sent: [],
    updated: [],
    metadataPatches: [],
    patchFailures: new Set(),
    registeredDirectories: [],
    aborted: [],
    deleted: [],
    deleteFailures: new Set(),
    holdReleases: [],
    pendingHidden: new Set(),
    parentMessages: [userMessage('p1'), assistantMessage('p2', 10)],
    providers: [provider('anthropic', { claude: providerModel('claude', { high: 'high', low: 'low' }) })],
    agents: [agent('build', 'primary')],
    runtimeKey: 'runtime-1',
    replies: new Map(),
    permissionReadbacks: new Map(),
    readbacks: 0,
    now: 0,
    runCounter: 0,
  };
  const registry = createConsultRunRegistry();

  const deps: ConsultRuntimeDeps = {
    client: {
      forkSession: async (sessionId, messageId, directory) => {
        state.forkCalls.push({ sessionId, messageId, directory });
        const callIndex = state.forkCalls.length;
        state.calls.push(`fork:${callIndex}`);
        const failure = state.forkFailures.get(callIndex);
        if (failure) throw failure;
        const session = sessionFixture(`fork-${callIndex}`, directory);
        if (!state.holdForks) return session;
        const gate = deferred<Session>();
        state.pendingForks.push({ gate, session });
        return gate.promise;
      },
      sendMessage: async (params) => {
        state.calls.push(`send:${params.id}`);
        state.sent.push(params);
        return `${params.id}-user`;
      },
      updateSession: async (id, patch, directory) => {
        state.calls.push(`update:${id}`);
        state.updated.push({ id, patch, directory });
        // Echo the written patch back, like the real server does, unless the
        // test forces an absent echo to exercise the getSession read-back.
        if (state.permissionReadbacks.get(id) !== 'echo-absent' && state.permissionReadbacks.get(id) !== 'refetch-present' && state.permissionReadbacks.get(id) !== 'wrong-rule' && state.permissionReadbacks.get(id) !== 'throw') {
          return { ...sessionFixture(id, directory), permission: patch.permission };
        }
        return sessionFixture(id, directory);
      },
      getSession: async (sessionId, directory) => {
        state.calls.push(`get:${sessionId}`);
        state.readbacks += 1;
        const forced = state.permissionReadbacks.get(sessionId);
        if (forced === 'refetch-present') {
          return { ...sessionFixture(sessionId, directory), permission: CONSULT_ADVISOR_PERMISSION };
        }
        if (forced === 'wrong-rule') {
          return { ...sessionFixture(sessionId, directory), permission: [{ permission: 'bash', pattern: '*', action: 'allow' }] };
        }
        if (forced === 'throw') throw new Error('session read failed');
        // Default refetch echoes absent, like a server that never persists the
        // ruleset on the Session payload.
        return sessionFixture(sessionId, directory);
      },
      getProvidersForConfig: async (directory) => {
        state.calls.push(`providers:${directory}`);
        if (state.surfaceError) throw state.surfaceError;
        return { providers: state.providers, default: {} };
      },
      listAgents: async (directory) => {
        state.calls.push(`agents:${directory}`);
        if (state.surfaceError) throw state.surfaceError;
        return state.agents;
      },
    },
    session: {
      patchSessionMetadata: async (sessionId, directory, updater, expectedRuntimeKey) => {
        state.calls.push(`patch:${sessionId}`);
        if (state.patchFailures.has(sessionId)) throw new Error(`patch failed: ${sessionId}`);
        state.metadataPatches.push({ id: sessionId, directory, expectedRuntimeKey, metadata: updater({}) });
        return sessionFixture(sessionId);
      },
      registerSessionDirectory: (sessionId, directory) => {
        state.calls.push(`registerDirectory:${sessionId}`);
        state.registeredDirectories.push({ id: sessionId, directory });
      },
      abortCurrentOperation: async (sessionId) => {
        state.calls.push(`abort:${sessionId}`);
        state.aborted.push(sessionId);
      },
      deleteSessionInDirectory: async (sessionId, directory, expectedRuntimeKey) => {
        state.calls.push(`delete:${sessionId}`);
        if (state.deleteFailures.has(sessionId)) throw new Error(`delete failed: ${sessionId}`);
        state.deleted.push({ id: sessionId, directory, expectedRuntimeKey });
        return true;
      },
    },
    pendingHide: {
      register: (sessionId) => {
        if (state.pendingHidden.has(sessionId)) return;
        state.pendingHidden.add(sessionId);
        state.calls.push(`register:${sessionId}`);
      },
      release: (sessionId) => {
        if (!state.pendingHidden.delete(sessionId)) return;
        state.calls.push(`release:${sessionId}`);
      },
    },
    runtimeKey: () => state.runtimeKey,
    readParentMessages: (sessionId, directory) => {
      state.calls.push(`parentMessages:${sessionId}:${directory}`);
      return state.parentMessages;
    },
    readForkMessages: async (sessionId, directory) => {
      state.calls.push(`read:${sessionId}:${directory}`);
      const script = state.replies.get(sessionId) ?? { kind: 'completed', text: `reply-${sessionId}` };
      if (script.kind === 'read-error') throw new Error('transcript unreadable');
      if (script.kind === 'deferred') return script.deferred.promise;
      return replyRecords(script, sessionId);
    },
    now: () => state.now,
    sleep: async (ms) => {
      state.now += ms;
    },
    createRunId: () => {
      state.runCounter += 1;
      return `run-${state.runCounter}`;
    },
    releaseAdmissionHold: (sessionId, owner) => {
      state.calls.push(`hold:${sessionId}:${owner}`);
      state.holdReleases.push({ sessionId, owner });
    },
    runRegistry: registry,
  };

  const releaseForks = (): void => {
    const pending = [...state.pendingForks];
    state.pendingForks.length = 0;
    for (const entry of pending) entry.gate.resolve(entry.session);
  };

  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  return { runtime: createConsultRuntime(deps), registry, state, releaseForks, flush };
};

const refusalOf = async (handle: { result: Promise<ConsultationResult> }): Promise<ConsultationRefusedError> => {
  const outcome = await handle.result.then(
    () => null,
    (error: Error) => error,
  );
  if (!(outcome instanceof ConsultationRefusedError)) {
    throw new Error(`expected a ConsultationRefusedError, received ${String(outcome)}`);
  }
  return outcome;
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('startConsultation fork lifecycle', () => {
  test('forks, hides, marks, locks down, dispatches, and cleans up in order', async () => {
    const harness = createHarness();
    const input = baseInput();
    const handle = harness.runtime.startConsultation(input);

    const result = await handle.result;

    expect(harness.state.forkCalls).toEqual([{ sessionId: 'parent', messageId: undefined, directory: '/work' }]);
    expect(harness.state.calls).toEqual([
      'providers:/work',
      'agents:/work',
      'parentMessages:parent:/work',
      'fork:1',
      'register:fork-1',
      'patch:fork-1',
      'release:fork-1',
      'registerDirectory:fork-1',
      'update:fork-1',
      'send:fork-1',
      'read:fork-1:/work',
      'delete:fork-1',
    ]);
    // The settle path does not release the admission hold (the submission
    // owns that).
    expect(harness.state.holdReleases).toEqual([]);

    // Marker replaces the inherited metadata and binds the run identity.
    expect(harness.state.metadataPatches).toEqual([
      {
        id: 'fork-1',
        directory: '/work',
        expectedRuntimeKey: 'runtime-1',
        metadata: {
          openchamber: {
            kind: 'consult-advisor',
            originalSessionID: 'parent',
            consultRunID: 'run-1',
            advisorIndex: 0,
          },
        },
      },
    ]);
    expect(harness.state.registeredDirectories).toEqual([{ id: 'fork-1', directory: '/work' }]);
    expect(harness.state.updated).toEqual([
      { id: 'fork-1', patch: { permission: CONSULT_ADVISOR_PERMISSION }, directory: '/work' },
    ]);

    // Exact dispatch: no substitution, no UI-store routing, framing as `system`,
    // and no participation in the shared provider circuit breaker (WP1.6).
    expect(harness.state.sent).toEqual([
      {
        id: 'fork-1',
        providerID: 'anthropic',
        modelID: 'claude',
        text: 'What should we do next?',
        agent: 'build',
        variant: 'high',
        files: input.attachments,
        directory: '/work',
        system: CONSULT_ADVISOR_SYSTEM_PROMPT,
        runtimeKey: 'runtime-1',
        trackProviderErrors: false,
      },
    ]);
    expect(harness.state.sent[0]?.trackProviderErrors).toBe(false);

    expect(result.status).toBe('ok');
    expect(result.runId).toBe('run-1');
    expect(result.parentSessionId).toBe('parent');
    expect(result.mode).toBe('parallel');
    expect(result.blocks).toEqual([{ text: 'reply-fork-1' }]);
    expect(result.advisors).toEqual([
      {
        index: 0,
        providerID: 'anthropic',
        modelID: 'claude',
        variant: 'high',
        agent: 'build',
        status: 'ok',
        durationMs: 0,
      },
    ]);
    expect(harness.state.deleted).toEqual([{ id: 'fork-1', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
    expect(harness.state.pendingHidden.size).toBe(0);
  });

  test('omits the variant when the selection has none and never substitutes', async () => {
    const harness = createHarness();
    const handle = harness.runtime.startConsultation(
      baseInput({ advisors: [selection({ variant: null })] }),
    );
    await handle.result;

    expect(harness.state.sent).toHaveLength(1);
    expect(harness.state.sent[0]?.providerID).toBe('anthropic');
    expect(harness.state.sent[0]?.modelID).toBe('claude');
    expect(harness.state.sent[0]?.agent).toBe('build');
    expect(harness.state.sent[0]?.variant).toBeUndefined();
  });

  test('falls back to the last completed assistant message for an unfinished parent', async () => {
    const harness = createHarness();
    harness.state.parentMessages = [
      userMessage('p1'),
      assistantMessage('p2', 10),
      userMessage('p3'),
      assistantMessage('p4', undefined),
    ];
    const handle = harness.runtime.startConsultation(baseInput());
    await handle.result;

    expect(harness.state.forkCalls).toEqual([{ sessionId: 'parent', messageId: 'p2', directory: '/work' }]);
  });

  test('deletes the fork and reports the failure when fork creation fails', async () => {
    const harness = createHarness();
    harness.state.forkFailures.set(1, new Error('fork exploded'));
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.blocks).toEqual([]);
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('fork exploded');
    expect(harness.state.sent).toEqual([]);
  });

  test('keeps other advisors running when one advisor fails', async () => {
    const harness = createHarness();
    harness.state.forkFailures.set(1, new Error('fork exploded'));
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection(), selection({ modelID: 'claude' })] }));
    const result = await handle.result;

    expect(result.status).toBe('partial');
    expect(result.advisors.map((advisor) => advisor.status)).toEqual(['failed', 'ok']);
    expect(result.blocks).toEqual([{ text: 'reply-fork-2' }]);
  });
});

describe('parallel and sequential fan-out', () => {
  test('parallel runs at most three advisor forks at once', async () => {
    const harness = createHarness();
    harness.state.holdForks = true;
    const handle = harness.runtime.startConsultation(
      baseInput({ advisors: [selection(), selection(), selection(), selection()] }),
    );

    await harness.flush();
    expect(harness.state.forkCalls).toHaveLength(3);

    harness.state.holdForks = false;
    harness.releaseForks();
    await harness.flush();
    expect(harness.state.forkCalls).toHaveLength(4);

    const result = await handle.result;
    expect(result.status).toBe('ok');
    expect(result.advisors).toHaveLength(4);
    expect(result.blocks).toHaveLength(4);
  });

  test('sequential starts the next advisor only after the previous one finishes', async () => {
    const harness = createHarness();
    harness.state.holdForks = true;
    const handle = harness.runtime.startConsultation(
      baseInput({ advisors: [selection(), selection()], mode: 'sequential' }),
    );

    await harness.flush();
    expect(harness.state.forkCalls).toHaveLength(1);

    harness.state.holdForks = false;
    harness.releaseForks();
    await harness.flush();
    expect(harness.state.forkCalls).toHaveLength(2);

    const result = await handle.result;
    expect(result.mode).toBe('sequential');
    expect(result.status).toBe('ok');
    expect(harness.state.calls.indexOf('read:fork-1:/work')).toBeLessThan(harness.state.calls.indexOf('fork:2'));
  });
});

describe('completion outcomes', () => {
  test('a timed-out advisor is reported as timeout and degrades the run', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-1', { kind: 'unfinished' });
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.blocks).toEqual([]);
    expect(result.advisors[0]?.status).toBe('timeout');
    expect(result.advisors[0]?.reason).toContain('30 ms');
  });

  test('empty visible output is a failure, not a successful block', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-1', { kind: 'empty' });
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.blocks).toEqual([]);
    expect(result.advisors[0]?.status).toBe('empty');
    expect(result.advisors[0]?.reason).toBe('The advisor returned no visible text');
  });

  test('an assistant error is reported with its reason', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-1', { kind: 'error', message: 'provider exploded' });
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('UnknownError: provider exploded');
  });

  test('partial success keeps the usable advisor output', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-2', { kind: 'empty' });
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection(), selection()] }));
    const result = await handle.result;

    expect(result.status).toBe('partial');
    expect(result.advisors.map((advisor) => advisor.status)).toEqual(['ok', 'empty']);
    expect(result.blocks).toEqual([{ text: 'reply-fork-1' }]);
  });

  test('all advisors failing resolves a degraded result the caller can dispatch', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-1', { kind: 'read-error' });
    harness.state.replies.set('fork-2', { kind: 'error', message: 'boom' });
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection(), selection()] }));
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.blocks).toEqual([]);
    expect(result.advisors.map((advisor) => advisor.status)).toEqual(['timeout', 'failed']);
  });
});

describe('cancellation and stale results', () => {
  test('cancel before the fork resolves prevents the send and cleans up the fork', async () => {
    const harness = createHarness();
    harness.state.holdForks = true;
    const handle = harness.runtime.startConsultation(baseInput());

    await harness.flush();
    expect(harness.state.forkCalls).toHaveLength(1);

    await harness.runtime.cancel(handle.runId);
    harness.releaseForks();
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(result.blocks).toEqual([]);
    expect(result.advisors[0]?.status).toBe('cancelled');
    expect(harness.state.sent).toEqual([]);
    expect(harness.state.calls).toContain('register:fork-1');
    expect(harness.state.calls).toContain('release:fork-1');
    expect(harness.state.deleted).toEqual([{ id: 'fork-1', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
    expect(harness.state.pendingHidden.size).toBe(0);
  });

  test('cancel during completion aborts the fork and ignores the late result', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const handle = harness.runtime.startConsultation(baseInput());

    await harness.flush();
    expect(harness.state.sent).toHaveLength(1);

    await harness.runtime.cancel(handle.runId);
    expect(harness.state.aborted).toEqual(['fork-1']);
    expect(harness.state.deleted).toEqual([{ id: 'fork-1', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
    expect(harness.state.pendingHidden.size).toBe(0);

    const callsAfterCancel = harness.state.calls.length;
    await harness.runtime.cancel(handle.runId);
    expect(harness.state.calls.length).toBe(callsAfterCancel);

    reply.resolve([record(userMessage('fork-1-user')), record(assistantMessage('fork-1-reply', 2), [textPart('fork-1-reply', 'too late')])]);
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(result.blocks).toEqual([]);
    expect(result.advisors[0]?.status).toBe('cancelled');
  });

  test('a runtime change mid-run cancels the run and drops the late result', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const handle = harness.runtime.startConsultation(baseInput());

    await harness.flush();
    expect(harness.state.sent).toHaveLength(1);

    harness.state.runtimeKey = 'runtime-2';
    reply.resolve([record(userMessage('fork-1-user')), record(assistantMessage('fork-1-reply', 2), [textPart('fork-1-reply', 'stale')])]);
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    expect(result.blocks).toEqual([]);
    expect(harness.state.deleted).toEqual([{ id: 'fork-1', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
  });
});

describe('cancellation, supersession, and cleanup (WP1.4)', () => {
  test('cancel records the token, releases the hold, aborts, and deletes in order', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const handle = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    expect(harness.state.sent).toHaveLength(1);

    const before = harness.state.calls.length;
    await harness.runtime.cancel(handle.runId);
    expect(harness.state.calls.slice(before)).toEqual(['hold:parent:consult:run-1', 'abort:fork-1', 'delete:fork-1']);

    // Idempotent: a second cancel and the settle path release nothing more.
    const afterCancel = harness.state.calls.length;
    await harness.runtime.cancel(handle.runId);
    expect(harness.state.calls.length).toBe(afterCancel);

    reply.resolve([]);
    const result = await handle.result;
    expect(result.status).toBe('cancelled');
    expect(result.blocks).toEqual([]);
    expect(harness.state.holdReleases).toEqual([{ sessionId: 'parent', owner: 'consult:run-1' }]);
  });

  test('a new run for the same parent supersedes and cleans the previous run before forking', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const first = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    expect(harness.state.sent).toHaveLength(1);

    const before = harness.state.calls.length;
    const second = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    await harness.flush();

    const order = harness.state.calls.slice(before);
    expect(order.indexOf('abort:fork-1')).toBeGreaterThan(-1);
    expect(order.indexOf('delete:fork-1')).toBeGreaterThan(order.indexOf('abort:fork-1'));
    expect(order.indexOf('fork:2')).toBeGreaterThan(order.indexOf('delete:fork-1'));

    // The superseded run's late result is ignored.
    reply.resolve([
      record(userMessage('fork-1-user')),
      record(assistantMessage('fork-1-reply', 2), [textPart('fork-1-reply', 'too late')]),
    ]);
    const firstResult = await first.result;
    expect(firstResult.status).toBe('cancelled');
    expect(firstResult.blocks).toEqual([]);
    expect(firstResult.advisors[0]?.status).toBe('cancelled');

    const secondResult = await second.result;
    expect(secondResult.status).toBe('ok');
    expect(secondResult.runId).toBe('run-2');
    expect(harness.state.sent.map((params) => params.id)).toEqual(['fork-1', 'fork-2']);
  });

  test('a superseded run releases only its own owner, never the superseding run hold', async () => {
    // The hold is owner-scoped per run: a superseded run's cancellation can
    // only clear `consult:<its run id>`, so the superseding run (and any other
    // owner, like auto-review) keeps its own hold no matter when the old run
    // cleans up.
    const harness = createHarness();
    const firstReply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: firstReply });
    const first = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    expect(harness.state.sent).toHaveLength(1);

    const secondReply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-2', { kind: 'deferred', deferred: secondReply });
    const second = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    await harness.flush();

    expect(harness.state.holdReleases).toEqual([{ sessionId: 'parent', owner: 'consult:run-1' }]);

    secondReply.resolve([
      record(userMessage('fork-2-user')),
      record(assistantMessage('fork-2-reply', 2), [textPart('fork-2-reply', 'fresh')]),
    ]);
    await second.result;
    // The superseding run's settle does not release either: the submission
    // that asserted the hold keeps it valid through its own dispatch.
    expect(harness.state.holdReleases).toEqual([{ sessionId: 'parent', owner: 'consult:run-1' }]);

    firstReply.resolve([]);
    await first.result;
    expect(harness.state.holdReleases).toEqual([{ sessionId: 'parent', owner: 'consult:run-1' }]);
  });

  test('the active-run registry covers the run for its whole lifetime', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const handle = harness.runtime.startConsultation(baseInput());
    await harness.flush();
    expect(harness.registry.isActive(handle.runId)).toBe(true);

    await harness.runtime.cancel(handle.runId);
    reply.resolve([]);
    await handle.result;
    expect(harness.registry.isActive(handle.runId)).toBe(false);
  });

  test('a marker failure deletes the fork and releases its pending-hide entry', async () => {
    const harness = createHarness();
    harness.state.patchFailures.add('fork-1');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toContain('Advisor setup failed: patch failed: fork-1');
    expect(harness.state.sent).toEqual([]);
    expect(harness.state.pendingHidden.size).toBe(0);
    expect(harness.state.deleted).toEqual([{ id: 'fork-1', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
  });

  test('a failed fork delete still releases its pending-hide entry', async () => {
    const harness = createHarness();
    harness.state.deleteFailures.add('fork-1');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('ok');
    expect(harness.state.pendingHidden.size).toBe(0);
  });

  test('a runtime change leaves the previous runtime hold to its server-side expiry', async () => {
    const harness = createHarness();
    const reply = deferred<readonly ConsultMessageRecord[]>();
    harness.state.replies.set('fork-1', { kind: 'deferred', deferred: reply });
    const handle = harness.runtime.startConsultation(baseInput());
    await harness.flush();

    harness.state.runtimeKey = 'runtime-2';
    reply.resolve([]);
    const result = await handle.result;

    expect(result.status).toBe('cancelled');
    // A hold belongs to the runtime that created it; releasing it through the
    // new runtime could touch a same-id session there.
    expect(harness.state.holdReleases).toEqual([]);
  });
});

describe('live advisor events (F5)', () => {
  test('sequential runs emit started/settled per advisor in order', async () => {
    const harness = createHarness();
    const events: Array<{ index: number; phase: string; status?: string }> = [];
    const handle = harness.runtime.startConsultation(baseInput({
      mode: 'sequential',
      advisors: [selection(), selection({ providerID: 'anthropic', modelID: 'claude' })],
      onAdvisor: (event) => events.push(event),
    }));
    const result = await handle.result;

    expect(result.status).toBe('ok');
    expect(events.map((event) => `${event.index}:${event.phase}${event.status ? `:${event.status}` : ''}`)).toEqual([
      '0:started',
      '0:settled:ok',
      '1:started',
      '1:settled:ok',
    ]);
    expect(harness.state.forkCalls).toHaveLength(2);
  });

  test('parallel runs emit started for every advisor and settled with terminal statuses', async () => {
    const harness = createHarness();
    const events: Array<{ index: number; phase: string; status?: string; reason?: string; durationMs?: number }> = [];
    const handle = harness.runtime.startConsultation(baseInput({
      advisors: [selection(), selection(), selection()],
      onAdvisor: (event) => events.push(event),
    }));
    const result = await handle.result;

    expect(result.status).toBe('ok');
    const started = events.filter((event) => event.phase === 'started').map((event) => event.index).sort();
    const settled = events.filter((event) => event.phase === 'settled');
    expect(started).toEqual([0, 1, 2]);
    expect(settled.map((event) => event.status)).toEqual(['ok', 'ok', 'ok']);
    expect(settled.every((event) => typeof event.durationMs === 'number')).toBe(true);
  });

  test('a failing advisor settles with failed and its reason', async () => {
    const harness = createHarness();
    harness.state.replies.set('fork-1', { kind: 'error', message: 'provider exploded' });
    const events: Array<{ index: number; phase: string; status?: string; reason?: string }> = [];
    const handle = harness.runtime.startConsultation(baseInput({
      onAdvisor: (event) => events.push(event),
    }));
    await handle.result;

    const settled = events.find((event) => event.phase === 'settled');
    expect(settled?.status).toBe('failed');
    expect(settled?.reason).toContain('provider exploded');
  });

  test('a cancelled run emits no events after the cancellation', async () => {
    const harness = createHarness();
    harness.state.holdForks = true;
    const events: Array<{ index: number; phase: string; status?: string }> = [];
    const handle = harness.runtime.startConsultation(baseInput({
      onAdvisor: (event) => events.push(event),
    }));
    await harness.flush();
    // Advisor 0 has started (the fork is pending) but nothing settled yet.
    expect(events.filter((event) => event.phase === 'started')).toHaveLength(1);

    await harness.runtime.cancel('run-1');
    harness.releaseForks();
    await harness.flush();
    const countAfterCancel = events.length;
    await harness.flush();
    await harness.flush();

    // The cancellation settles advisor 0 as cancelled; nothing fires after.
    expect(events.filter((event) => event.phase === 'settled').map((event) => event.status)).toEqual(['cancelled']);
    expect(events).toHaveLength(countAfterCancel);
    // The cancelled run never reuses the fork: no send, no completion.
    expect(harness.state.sent).toEqual([]);
  });

  test('a throwing onAdvisor never breaks the advisor path', async () => {
    const harness = createHarness();
    const handle = harness.runtime.startConsultation(baseInput({
      onAdvisor: () => {
        throw new Error('panel exploded');
      },
    }));
    const result = await handle.result;
    expect(result.status).toBe('ok');
    expect(harness.state.sent).toHaveLength(1);
  });
});

describe('start refusals', () => {
  test('an unavailable advisor refuses the start before any fork', async () => {
    const harness = createHarness();
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection({ modelID: 'missing' })] }));

    const refusal = await refusalOf(handle);
    expect(refusal.code).toBe('invalid-advisor');
    expect(refusal.rejections).toEqual([
      { index: 0, code: 'model-unknown', message: 'Model "anthropic/missing" is not available' },
    ]);
    expect(harness.state.forkCalls).toEqual([]);
    expect(harness.state.sent).toEqual([]);
  });

  test('an unfinished parent with no completed turn refuses the start', async () => {
    const harness = createHarness();
    harness.state.parentMessages = [userMessage('p1'), assistantMessage('p2', undefined)];
    const handle = harness.runtime.startConsultation(baseInput());

    const refusal = await refusalOf(handle);
    expect(refusal.code).toBe('no-settled-context');
    expect(harness.state.forkCalls).toEqual([]);
  });

  test('a stale runtime key refuses the start', async () => {
    const harness = createHarness();
    const handle = harness.runtime.startConsultation(baseInput({ expectedRuntimeKey: 'runtime-stale' }));

    const refusal = await refusalOf(handle);
    expect(refusal.code).toBe('runtime-changed');
    expect(harness.state.forkCalls).toEqual([]);
  });

  test('an empty advisor list refuses the start', async () => {
    const harness = createHarness();
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [] }));

    const refusal = await refusalOf(handle);
    expect(refusal.code).toBe('no-advisors');
    expect(harness.state.forkCalls).toEqual([]);
  });

  test('an unreadable model surface refuses the start instead of forking unvalidated', async () => {
    const harness = createHarness();
    harness.state.surfaceError = new Error('providers endpoint down');
    const handle = harness.runtime.startConsultation(baseInput());

    const refusal = await refusalOf(handle);
    expect(refusal.code).toBe('surface-unavailable');
    expect(refusal.message).toContain('providers endpoint down');
    expect(harness.state.forkCalls).toEqual([]);
  });

  test('the admission hook runs before any fork and its failure refuses the start', async () => {
    const harness = createHarness();
    let admitted = false;
    const handle = harness.runtime.startConsultation(
      baseInput({
        assertAdmissible: () => {
          admitted = true;
          throw new Error('not at the queue head');
        },
      }),
    );

    const outcome = await handle.result.then(
      () => null,
      (error: Error) => error,
    );
    expect(admitted).toBe(true);
    expect(outcome?.message).toBe('not at the queue head');
    expect(harness.state.forkCalls).toEqual([]);
  });
});

describe('prevalidateConsultation (F2)', () => {
  test('throws invalid-advisor for an unknown model without creating a fork', async () => {
    const harness = createHarness();
    const refusal = await harness.runtime.prevalidateConsultation(
      baseInput({ advisors: [selection({ modelID: 'missing' })] }),
    ).then(
      () => null,
      (error: Error) => error,
    );

    expect(refusal).toBeInstanceOf(ConsultationRefusedError);
    if (!(refusal instanceof ConsultationRefusedError)) throw new Error('expected a refusal');
    expect(refusal.code).toBe('invalid-advisor');
    expect(refusal.rejections).toEqual([
      { index: 0, code: 'model-unknown', message: 'Model "anthropic/missing" is not available' },
    ]);
    // Prevalidation reads the surface only: the advisor check fails before
    // the parent transcript is read.
    expect(harness.state.forkCalls).toEqual([]);
    expect(harness.state.sent).toEqual([]);
    expect(harness.state.calls).toEqual([
      'providers:/work',
      'agents:/work',
    ]);
  });

  test('throws no-settled-context for an unfinished parent without creating a fork', async () => {
    const harness = createHarness();
    harness.state.parentMessages = [userMessage('p1'), assistantMessage('p2', undefined)];
    const refusal = await harness.runtime.prevalidateConsultation(baseInput()).then(
      () => null,
      (error: Error) => error,
    );

    expect(refusal).toBeInstanceOf(ConsultationRefusedError);
    if (!(refusal instanceof ConsultationRefusedError)) throw new Error('expected a refusal');
    expect(refusal.code).toBe('no-settled-context');
    expect(harness.state.forkCalls).toEqual([]);
    expect(harness.state.sent).toEqual([]);
  });

  test('resolves for a valid selection without creating a fork', async () => {
    const harness = createHarness();
    const outcome = await harness.runtime.prevalidateConsultation(baseInput()).then(
      () => 'ok',
      (error: Error) => error,
    );
    expect(outcome).toBe('ok');
    expect(harness.state.forkCalls).toEqual([]);
    expect(harness.state.sent).toEqual([]);
  });
});

describe('permission read-back verification (F3)', () => {
  test('an echoed deny-all ruleset lets the advisor run normally', async () => {
    const harness = createHarness();
    harness.state.permissionReadbacks.set('fork-1', 'echo');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('ok');
    expect(harness.state.sent).toHaveLength(1);
    // No refetch needed when the write echo already carries the rule.
    expect(harness.state.readbacks).toBe(0);
  });

  test('an absent ruleset that the refetch also lacks fails the advisor closed', async () => {
    const harness = createHarness();
    harness.state.permissionReadbacks.set('fork-1', 'echo-absent');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    // The only advisor failing leaves the run degraded, never a send.
    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('permission-verification-failed');
    expect(harness.state.sent).toEqual([]);
    // The failed fork was deleted like other failed setups.
    expect(harness.state.deleted.map((entry) => entry.id)).toEqual(['fork-1']);
    expect(harness.state.readbacks).toBe(1);
  });

  test('an absent echo with a present refetch lets the advisor proceed', async () => {
    const harness = createHarness();
    harness.state.permissionReadbacks.set('fork-1', 'refetch-present');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('ok');
    expect(harness.state.sent).toHaveLength(1);
    expect(harness.state.readbacks).toBe(1);
  });

  test('a ruleset without the exact deny-all wildcard fails the advisor', async () => {
    const harness = createHarness();
    // A permissive-looking but non-matching ruleset is not the verified lock:
    // the write echo is absent and the refetch only carries a bash allow rule.
    harness.state.permissionReadbacks.set('fork-1', 'wrong-rule');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('permission-verification-failed');
    expect(harness.state.sent).toEqual([]);
    expect(harness.state.deleted.map((entry) => entry.id)).toEqual(['fork-1']);
  });

  test('a failed read-back request fails closed instead of sending unverified', async () => {
    const harness = createHarness();
    harness.state.permissionReadbacks.set('fork-1', 'throw');
    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('permission-verification-failed');
    expect(harness.state.sent).toEqual([]);
    expect(harness.state.deleted.map((entry) => entry.id)).toEqual(['fork-1']);
  });

  test('one unverified advisor fails alone and the run continues with the others', async () => {
    const harness = createHarness();
    harness.state.permissionReadbacks.set('fork-1', 'echo-absent');
    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection(), selection()] }));
    const result = await handle.result;

    expect(result.status).toBe('partial');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('permission-verification-failed');
    expect(result.advisors[1]?.status).toBe('ok');
    expect(harness.state.sent).toHaveLength(1);
  });
});

describe('ambiguous fork failure', () => {
  test('reports the advisor failed and never touches a session it did not fork', async () => {
    const harness = createHarness();
    harness.state.forkFailures.set(1, new Error('fork response lost'));

    const handle = harness.runtime.startConsultation(baseInput());
    const result = await handle.result;

    expect(result.status).toBe('degraded');
    expect(result.advisors[0]?.status).toBe('failed');
    expect(result.advisors[0]?.reason).toBe('fork response lost');
    // Accepted bound: the server may have created the clone before the
    // response was lost, but "a session id that appeared after a listing"
    // cannot prove it (it could equally belong to the user, another client,
    // or another run), so the run never lists, hides, marks, or deletes
    // anything it did not receive from forkSession. A possible clone stays
    // exactly as it is — visible until the user deletes it manually.
    expect(harness.state.calls).toEqual([
      'providers:/work',
      'agents:/work',
      'parentMessages:parent:/work',
      'fork:1',
    ]);
    expect(harness.state.metadataPatches).toEqual([]);
    expect(harness.state.deleted).toEqual([]);
    expect(harness.state.pendingHidden.size).toBe(0);
    expect(harness.state.registeredDirectories).toEqual([]);
    expect(harness.state.updated).toEqual([]);
    expect(harness.state.aborted).toEqual([]);
  });

  test('only cleans up the forks it received; the failed sibling leaves no trace', async () => {
    const harness = createHarness();
    harness.state.forkFailures.set(1, new Error('fork response lost'));

    const handle = harness.runtime.startConsultation(baseInput({ advisors: [selection(), selection()] }));
    const result = await handle.result;

    expect(result.status).toBe('partial');
    expect(result.advisors.map((advisor) => advisor.status)).toEqual(['failed', 'ok']);
    // The successful fork is the only session the run ever touches; the
    // ambiguous sibling contributes no hide, marker, or delete.
    expect(harness.state.metadataPatches.map((patch) => patch.id)).toEqual(['fork-2']);
    expect(harness.state.deleted).toEqual([{ id: 'fork-2', directory: '/work', expectedRuntimeKey: 'runtime-1' }]);
    expect(harness.state.pendingHidden.size).toBe(0);
  });
});
