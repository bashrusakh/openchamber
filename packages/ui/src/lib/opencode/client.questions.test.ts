import { beforeEach, describe, expect, mock, test } from 'bun:test';

type QuestionFixture = {
  id: string;
  sessionID: string;
  questions: Array<{
    question: string;
    header: string;
    options: Array<{ label: string; description: string }>;
    multiple?: boolean;
  }>;
  tool?: { messageID: string; callID: string };
};

const makeQuestion = (id: string, overrides?: Partial<QuestionFixture>): QuestionFixture => ({
  id,
  sessionID: `ses_${id}`,
  questions: [
    {
      question: `${id}: proceed with the plan?`,
      header: 'Build',
      options: [
        { label: 'Yes', description: 'Proceed' },
        { label: 'No', description: 'Cancel' },
      ],
    },
  ],
  ...overrides,
});

/**
 * Build a HeyApi success result matching the wrapper's V2 expectations:
 *   - error === undefined (success branch)
 *   - data.data === the item array (200 status payload nests the list
 *     under its own `data` field, same as session.permission.*)
 *   - response.status === 200
 */
const makeV2SuccessResult = (items: QuestionFixture[]) => ({
  data: { data: items },
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

const makeV2ErrorResult = (status: number) => ({
  data: undefined,
  error: { name: 'ServerError', data: { message: 'err' } },
  request: new Request('http://test/'),
  response: new Response(null, { status }),
});

const makeV1ListResult = (items: QuestionFixture[]) => ({
  data: items,
  error: undefined,
  request: new Request('http://test/'),
  response: new Response(null, { status: 200 }),
});

type V2Response =
  | { kind: 'ok'; items: QuestionFixture[] | unknown[] }
  | { kind: 'server-error' }
  | { kind: 'throw' };

/**
 * Calls arrive in listPendingQuestions' fixed order: unscoped first, then
 * one call per unique normalized directory. Each test resolves every call
 * it triggered, so index-order resolution is unambiguous.
 */
const v2PendingResolutions: Array<(r: V2Response) => void> = [];
const v2ListArgs: Array<{ location?: { directory?: string } } | undefined> = [];

const questionV2ListMock = mock((args?: { location?: { directory?: string } }) => {
  v2ListArgs.push(args);
  return new Promise<unknown>((resolve, reject) => {
    v2PendingResolutions.push((r: V2Response) => {
      if (r.kind === 'throw') {
        reject(new Error('network down'));
      } else if (r.kind === 'ok') {
        // SAFETY: the malformed-item test intentionally feeds a payload that
        // violates the QuestionFixture contract; the parser under test must
        // reject it.
        resolve(makeV2SuccessResult(r.items as QuestionFixture[]));
      } else {
        resolve(makeV2ErrorResult(500));
      }
    });
  });
});

let v1ListResult: unknown = makeV1ListResult([]);
const v1ListArgs: Array<{ directory?: string } | undefined> = [];

const questionV1ListMock = mock((args?: { directory?: string }) => {
  v1ListArgs.push(args);
  return Promise.resolve(v1ListResult);
});

const createOpencodeClientMock = mock(() => ({
  question: {
    list: questionV1ListMock,
  },
  v2: {
    question: {
      request: {
        list: questionV2ListMock,
      },
    },
  },
}));

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: createOpencodeClientMock,
}));

mock.module('@/contexts/runtimeAPIRegistry', () => ({
  getRegisteredRuntimeAPIs: mock(() => null),
}));

mock.module('@/lib/runtime-url', () => ({
  getRuntimeUrlResolver: mock(() => ({
    api: (path: string) => path,
  })),
}));

mock.module('@/lib/runtime-switch', () => ({
  getRuntimeApiBaseUrl: mock(() => ''),
  getRuntimeKey: mock(() => 'test-runtime'),
}));

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async () => new Response(JSON.stringify([]), {
    headers: { 'Content-Type': 'application/json' },
  })),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test-questions=${Date.now()}`);

const resolveV2Calls = (responses: V2Response[]) => {
  queueMicrotask(() => {
    for (const [i, response] of responses.entries()) {
      const resolver = v2PendingResolutions[i];
      if (resolver) resolver(response);
    }
  });
};

beforeEach(() => {
  v2PendingResolutions.length = 0;
  v2ListArgs.length = 0;
  v1ListArgs.length = 0;
  v1ListResult = makeV1ListResult([]);
});

describe('opencodeClient.listPendingQuestions (V2 read adoption)', () => {
  test('maps V2 items 1:1, preserving unscoped + per-directory merge and id-dedupe', async () => {
    // Same-id duplicate across the unscoped and per-directory results is
    // deduped; the unscoped occurrence (first result) wins.
    const globalQuestion = makeQuestion('q1', { tool: { messageID: 'msg_1', callID: 'call_1' } });
    const duplicateQuestion = makeQuestion('q1');
    const scopedQuestion = makeQuestion('q2', {
      questions: [
        { question: 'q2: pick one', header: 'Mode', options: [{ label: 'Fast', description: 'Fast' }], multiple: true },
      ],
    });

    const promise = opencodeClient.listPendingQuestions({ directories: ['/repo'] });
    resolveV2Calls([
      { kind: 'ok', items: [globalQuestion] },
      { kind: 'ok', items: [duplicateQuestion, scopedQuestion] },
    ]);
    const result = await promise;

    expect(result).toEqual([globalQuestion, scopedQuestion]);
    expect(v2ListArgs).toEqual([undefined, { location: { directory: '/repo' } }]);
    expect(v1ListArgs).toEqual([]);
  });

  test('falls back to V1 per-directory results when every V2 call errors', async () => {
    const v1Question = makeQuestion('v1q');
    v1ListResult = makeV1ListResult([v1Question]);

    const promise = opencodeClient.listPendingQuestions({ directories: ['/repo'] });
    resolveV2Calls([
      { kind: 'server-error' },
      { kind: 'server-error' },
    ]);
    const result = await promise;

    expect(result).toEqual([v1Question]);
    expect(v1ListArgs).toEqual([undefined, { directory: '/repo' }]);
  });

  test('falls back to V1 when the V2 SDK call throws (network failure)', async () => {
    const v1Question = makeQuestion('v1net');
    v1ListResult = makeV1ListResult([v1Question]);

    const promise = opencodeClient.listPendingQuestions({ directories: ['/repo'] });
    resolveV2Calls([
      { kind: 'throw' },
      { kind: 'throw' },
    ]);
    const result = await promise;

    expect(result).toEqual([v1Question]);
    expect(v1ListArgs).toEqual([undefined, { directory: '/repo' }]);
    expect(v2ListArgs).toEqual([undefined, { location: { directory: '/repo' } }]);
  });

  test('rejects the V2 attempt when any item is malformed and falls back conservatively', async () => {
    // Malformed unscoped item (missing questions array) → whole V2 attempt
    // for that call is rejected; V1 answers unscoped while the scoped V2
    // call still succeeds per call.
    const scopedQuestion = makeQuestion('v2q');
    const v1Question = makeQuestion('v1q');
    v1ListResult = makeV1ListResult([v1Question]);

    const promise = opencodeClient.listPendingQuestions({ directories: ['/repo'] });
    resolveV2Calls([
      // Malformed unscoped item (missing questions array): the parser under
      // test must reject it; V1 answers unscoped while the scoped V2 call
      // still succeeds per call.
      { kind: 'ok', items: [{ id: 'broken', sessionID: 'ses_broken' }] },
      { kind: 'ok', items: [scopedQuestion] },
    ]);
    const result = await promise;

    expect(result).toEqual([v1Question, scopedQuestion]);
    expect(v1ListArgs).toEqual([undefined]);
    expect(v2ListArgs).toEqual([undefined, { location: { directory: '/repo' } }]);
  });

  test('keeps the V2 unscoped + per-directory call pattern when V2 succeeds empty', async () => {
    const promise = opencodeClient.listPendingQuestions({ directories: ['/repo'] });
    resolveV2Calls([
      { kind: 'ok', items: [] },
      { kind: 'ok', items: [] },
    ]);
    const result = await promise;

    expect(result).toEqual([]);
    expect(v2ListArgs).toEqual([undefined, { location: { directory: '/repo' } }]);
    expect(v1ListArgs).toEqual([]);
  });
});