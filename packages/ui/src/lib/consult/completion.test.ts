import { describe, expect, test } from 'bun:test';
import type { Message, Part } from '@opencode-ai/sdk/v2';
import {
  CONSULT_COMPLETION_POLL_INTERVAL_MS,
  CONSULT_COMPLETION_TIMEOUT_MS,
  waitForConsultAdvisorCompletion,
  type ConsultCompletionDeps,
  type ConsultCompletionOptions,
  type ConsultCompletionOutcome,
  type ConsultMessageRecord,
} from './completion';

const userMessage = (id: string): Message => ({
  id,
  sessionID: 'advisor',
  role: 'user',
  time: { created: 1 },
  agent: 'build',
  model: { providerID: 'anthropic', modelID: 'claude' },
});

const assistantMessage = (id: string, completed: number | undefined): Message => {
  // SAFETY: the completion reader reads only role, id, time.completed, and the
  // optional error; the remaining AssistantMessage fields are irrelevant.
  return { id, sessionID: 'advisor', role: 'assistant', time: { created: 1, completed } } as Message;
};

const failedAssistantMessage = (id: string): Message => {
  // SAFETY: the reader reads only the error's name and data.message; the other
  // AssistantMessage fields are irrelevant to failure detection.
  return {
    id,
    sessionID: 'advisor',
    role: 'assistant',
    time: { created: 1, completed: 2 },
    error: { name: 'UnknownError', data: { message: 'provider exploded' } },
  } as Message;
};

const textPart = (messageID: string, text: string, synthetic = false): Part => {
  const part: Extract<Part, { type: 'text' }> = {
    id: `${messageID}-text-${text.length}`,
    sessionID: 'advisor',
    messageID,
    type: 'text',
    text,
  };
  if (synthetic) part.synthetic = true;
  return part;
};

const record = (info: Message, parts: Part[] = []): ConsultMessageRecord => ({ info, parts });

type ReadStep = { records: readonly ConsultMessageRecord[] } | { error: Error };

type ScriptedRead = {
  read: ConsultCompletionDeps['readMessages'];
  calls: () => number;
};

const scriptedRead = (steps: readonly ReadStep[]): ScriptedRead => {
  let index = 0;
  return {
    read: async () => {
      const step = steps[Math.min(index, steps.length - 1)];
      index += 1;
      if (!step) throw new Error('scriptedRead has no steps');
      if ('error' in step) throw step.error;
      return step.records;
    },
    calls: () => index,
  };
};

const clock = (): Pick<ConsultCompletionDeps, 'now' | 'sleep'> => {
  let now = 0;
  return {
    now: () => now,
    sleep: async (ms: number) => {
      now += ms;
    },
  };
};

const options = (userMessageID = 'u1'): ConsultCompletionOptions => ({
  sessionID: 'advisor',
  directory: '/work',
  userMessageID,
  timeoutMs: 30,
  pollIntervalMs: 10,
});

const wait = (deps: ConsultCompletionDeps, opts = options()): Promise<ConsultCompletionOutcome> =>
  waitForConsultAdvisorCompletion(deps, opts);

describe('defaults', () => {
  test('a per-advisor deadline of 120 s and a 1 s poll interval', () => {
    expect(CONSULT_COMPLETION_TIMEOUT_MS).toBe(120_000);
    expect(CONSULT_COMPLETION_POLL_INTERVAL_MS).toBe(1_000);
  });
});

describe('waitForConsultAdvisorCompletion', () => {
  test('returns the visible text of the trailing completed reply', async () => {
    const { read } = scriptedRead([
      {
        records: [
          record(userMessage('u1')),
          record(assistantMessage('a1', 2), [textPart('a1', 'synthetic context', true), textPart('a1', 'first'), textPart('a1', 'second')]),
        ],
      },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({ status: 'completed', messageID: 'a1', text: 'first\nsecond' });
  });

  test('keeps waiting while the trailing reply is unfinished', async () => {
    const { read, calls } = scriptedRead([
      { records: [record(userMessage('u1')), record(assistantMessage('a1', undefined), [textPart('a1', 'partial')])] },
      { records: [record(userMessage('u1')), record(assistantMessage('a1', 2), [textPart('a1', 'done')])] },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({ status: 'completed', messageID: 'a1', text: 'done' });
    expect(calls()).toBe(2);
  });

  test('reports empty when the completed reply has no visible text', async () => {
    const { read } = scriptedRead([
      {
        records: [
          record(userMessage('u1')),
          record(assistantMessage('a1', 2), [textPart('a1', 'hidden', true), textPart('a1', '   ')]),
        ],
      },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({ status: 'empty', messageID: 'a1', reason: 'The advisor returned no visible text' });
  });

  test('reports an assistant error as a failure reason', async () => {
    const { read } = scriptedRead([
      { records: [record(userMessage('u1')), record(failedAssistantMessage('a1'))] },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({ status: 'error', messageID: 'a1', reason: 'UnknownError: provider exploded' });
  });

  test('a read failure is unknown, not empty: the wait continues to a real reply', async () => {
    const { read, calls } = scriptedRead([
      { error: new Error('network down') },
      { records: [record(userMessage('u1')), record(assistantMessage('a1', 2), [textPart('a1', 'late')])] },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({ status: 'completed', messageID: 'a1', text: 'late' });
    expect(calls()).toBe(2);
  });

  test('read failures that never resolve end in a timeout, not an empty success', async () => {
    const { read } = scriptedRead([{ error: new Error('network down') }]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome.status).toBe('timeout');
    if (outcome.status !== 'timeout') throw new Error('expected timeout');
    expect(outcome.reason).toContain('unreadable transcript reads');
  });

  test('an inherited assistant message before the sent message is never the reply', async () => {
    const { read, calls } = scriptedRead([
      {
        records: [
          record(assistantMessage('inherited', 1), [textPart('inherited', 'from the main thread')]),
          record(userMessage('u1')),
        ],
      },
    ]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome.status).toBe('timeout');
    expect(calls()).toBeGreaterThan(1);
  });

  test('a deadline with no reply times out', async () => {
    const { read } = scriptedRead([{ records: [record(userMessage('u1'))] }]);
    const outcome = await wait({ ...clock(), readMessages: read });
    expect(outcome).toEqual({
      status: 'timeout',
      reason: 'The advisor did not complete within 30 ms',
    });
  });

  test('cancellation is checked before the first read', async () => {
    const { read, calls } = scriptedRead([{ records: [] }]);
    const outcome = await wait({ ...clock(), readMessages: read, }, { ...options(), isCancelled: () => true });
    expect(outcome).toEqual({ status: 'cancelled' });
    expect(calls()).toBe(0);
  });

  test('cancellation after a read resolves wins over a late reply', async () => {
    let checks = 0;
    const { read } = scriptedRead([
      { records: [record(userMessage('u1')), record(assistantMessage('a1', 2), [textPart('a1', 'late')])] },
    ]);
    const outcome = await wait(
      { ...clock(), readMessages: read },
      {
        ...options(),
        isCancelled: () => {
          checks += 1;
          return checks > 1;
        },
      },
    );
    expect(outcome).toEqual({ status: 'cancelled' });
  });
});
