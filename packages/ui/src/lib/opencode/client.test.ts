import { beforeEach, describe, expect, mock, test } from 'bun:test';

type ConfigResponse = { data: Record<string, unknown> };
type ProvidersResponse = { data: { providers: []; default: { default: string } } };
const providerResolvers: Array<(response: ProvidersResponse) => void> = [];

(mock as unknown as { restore?: () => void }).restore?.();

const configResolvers: Array<(response: ConfigResponse) => void> = [];
let configCalls = 0;
let runtimeKey = 'test-runtime';
const promptAsyncCalls: unknown[][] = [];
const promptAsyncResults: Array<unknown> = [];
const pathGetResults: Array<unknown> = [];

const promptAsyncMock = mock(async (...args: unknown[]) => {
  promptAsyncCalls.push(args);
  const next = promptAsyncResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { response: new Response(null, { status: 200 }) };
});

const promptAsyncBody = (index: number): Record<string, unknown> => {
  const body = promptAsyncCalls[index]?.[0] as Record<string, unknown> | undefined;
  if (!body) throw new Error(`promptAsync call ${index} has no body`);
  return body;
};

const sessionUpdateCalls: unknown[][] = [];
const sessionUpdateResults: Array<unknown> = [];

const sessionUpdateMock = mock(async (...args: unknown[]) => {
  sessionUpdateCalls.push(args);
  const next = sessionUpdateResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { data: { id: 'ses_1' } };
});

let pathGetCalls = 0;
const pathGetMock = mock(async () => {
  pathGetCalls += 1;
  const next = pathGetResults.shift();
  if (next instanceof Error) throw next;
  return next ?? { data: { directory: '/workspace/project' } };
});

mock.module('@opencode-ai/sdk/v2', () => ({
  createOpencodeClient: mock(() => ({
    config: {
      providers: () => new Promise<ProvidersResponse>((resolve) => { providerResolvers.push(resolve); }),
      get: mock(() => {
        configCalls += 1;
        return new Promise<ConfigResponse>((resolve) => {
          configResolvers.push(resolve);
        });
      }),
    },
    session: {
      promptAsync: promptAsyncMock,
      update: sessionUpdateMock,
    },
    path: {
      get: pathGetMock,
    },
  })),
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
  getRuntimeKey: mock(() => runtimeKey),
}));

type DirectoryProbeQuery = { path?: string };
const runtimeFetchCalls: Array<{ path: string; query: DirectoryProbeQuery | undefined }> = [];
const runtimeFetchResults: Array<Response | Error> = [];
const fsHomeResponses: Array<Response | Error> = [];

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: mock(async (input: string | URL | Request, init?: { query?: DirectoryProbeQuery }) => {
    if (typeof input === 'string' && input.includes('/fs/home')) {
      const next = fsHomeResponses.shift();
      if (next instanceof Error) throw next;
      if (next) return next;
    }
    if (typeof input === 'string') runtimeFetchCalls.push({ path: input, query: init?.query });
    const next = runtimeFetchResults.shift();
    if (next instanceof Error) throw next;
    return next ?? new Response(JSON.stringify([]), {
      headers: { 'Content-Type': 'application/json' },
    });
  }),
}));

mock.module('@/lib/startupTrace', () => ({
  markStartupTrace: mock(() => undefined),
}));

const { opencodeClient } = await import(`./client?cache-test=${Date.now()}`);

beforeEach(() => {
  runtimeKey = 'test-runtime';
  promptAsyncCalls.length = 0;
  promptAsyncResults.length = 0;
  sessionUpdateCalls.length = 0;
  sessionUpdateResults.length = 0;
  pathGetResults.length = 0;
  pathGetCalls = 0;
  runtimeFetchCalls.length = 0;
  runtimeFetchResults.length = 0;
  fsHomeResponses.length = 0;
});

test('same-URL reconnect isolates provider requests and old completion cannot delete new deduplication', async () => {
  const oldClient = opencodeClient.getSdkClient();
  const oldRequest = opencodeClient.getProvidersForConfig('/same/path');
  opencodeClient.reconnectToRuntimeBaseUrl();
  expect(opencodeClient.getSdkClient()).not.toBe(oldClient);
  const newRequest = opencodeClient.getProvidersForConfig('/same/path');
  expect(providerResolvers).toHaveLength(2);
  providerResolvers[0]({ data: { providers: [], default: { default: 'old' } } });
  await oldRequest;
  const joinedRequest = opencodeClient.getProvidersForConfig('/same/path');
  expect(providerResolvers).toHaveLength(2);
  providerResolvers[1]({ data: { providers: [], default: { default: 'new' } } });
  expect((await newRequest).default.default).toBe('new');
  expect((await joinedRequest).default.default).toBe('new');
});

test('Windows drive roots remain absolute in directory selection and SDK client identity', () => {
  const previous = opencodeClient.getDirectory();
  try {
    opencodeClient.setDirectory('c:\\');
    expect(opencodeClient.getDirectory()).toBe('C:/');
    expect(opencodeClient.getScopedSdkClient('c:\\')).toBe(opencodeClient.getScopedSdkClient('C:/'));
    expect(opencodeClient.getScopedSdkClient('C:/')).not.toBe(opencodeClient.getScopedSdkClient('C:'));
  } finally {
    opencodeClient.setDirectory(previous);
  }
});

test('Windows separators and UNC representations share SDK clients without lowercasing directory names', () => {
  expect(opencodeClient.getScopedSdkClient('c:\\Users\\Developer\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('C:/Users/Developer/Project'));
  expect(opencodeClient.getScopedSdkClient('\\\\Server\\Share\\Project\\'))
    .toBe(opencodeClient.getScopedSdkClient('//Server/Share/Project'));
  expect(opencodeClient.getScopedSdkClient('/repo/Project'))
    .not.toBe(opencodeClient.getScopedSdkClient('/repo/project'));
});

test('a drive-root system-info fallback stays absolute', async () => {
  pathGetResults.push({ data: { directory: 'C:/' } });
  expect((await opencodeClient.getSystemInfo()).homeDirectory).toBe('C:/');
});

describe('opencodeClient directory availability', () => {
  type ProbeBody = { error: string; reason?: string } | { isDirectory: boolean } | { isFile: boolean; size: number };
  const json = (status: number, body: ProbeBody): Response => new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

  test('stats the directory through the OpenChamber filesystem route, never through OpenCode path resolution', async () => {
    runtimeFetchResults.push(json(200, { isDirectory: true }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('available');
    expect(runtimeFetchCalls).toEqual([{ path: '/api/fs/directory-stat', query: { path: '/private/deleted-worktree' } }]);
    expect(pathGetCalls).toBe(0);
  });

  test('distinguishes a missing directory from an unavailable probe', async () => {
    runtimeFetchResults.push(json(404, { error: 'Directory not found', reason: 'not-found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(400, { error: 'Specified path is not a directory', reason: 'not-directory' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('missing');

    runtimeFetchResults.push(json(200, { isFile: true, size: 12 }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(404, { error: 'Not Found' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(500, { error: 'Failed to stat path' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(403, { error: 'Access to directory denied', reason: 'os-permission' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(json(501, { error: 'Unsupported' }));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');

    runtimeFetchResults.push(new Error('offline'));
    expect(await opencodeClient.getDirectoryAvailability('/private/deleted-worktree')).toBe('unknown');
  });
});

describe('opencodeClient getFilesystemHomeInfo', () => {
  type HomePayload = { home?: string; chatsRoot?: string | number };
  const fsHomeResponse = (body: HomePayload) => new Response(JSON.stringify(body), {
    headers: { 'Content-Type': 'application/json' },
  });

  test('returns the server-provided chats root', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester', chatsRoot: '/srv/openchamber-chats' });
  });

  test('returns the home for an older server that answers without chatsRoot', async () => {
    fsHomeResponses.push(fsHomeResponse({ home: '/Users/tester' }));
    expect(await opencodeClient.getFilesystemHomeInfo()).toEqual({ home: '/Users/tester' });
  });

  test('throws on a failed fetch', async () => {
    fsHomeResponses.push(new Error('transient network failure'));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('transient network failure');
  });

  test('throws on a non-ok response', async () => {
    fsHomeResponses.push(new Response('unavailable', { status: 503 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow('503');
  });

  test('rejects missing home and relative roots rather than caching a fallback', async () => {
    fsHomeResponses.push(fsHomeResponse({}));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
    fsHomeResponses.push(fsHomeResponse({ home: '/home/user', chatsRoot: 'relative' }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });

  test('throws on a malformed payload', async () => {
    fsHomeResponses.push(fsHomeResponse({ chatsRoot: 42 }));
    await expect(opencodeClient.getFilesystemHomeInfo()).rejects.toThrow();
  });
});

describe('opencodeClient getConfig cache', () => {
  test('cleared stale in-flight requests do not repopulate cache or delete newer in-flight requests', async () => {
    const first = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(1);

    opencodeClient.clearConfigCache();

    const second = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[0]?.({ data: { model: 'old/model' } });
    expect(await first).toEqual({ model: 'old/model' });

    const third = opencodeClient.getConfig('/workspace/project');
    expect(configCalls).toBe(2);

    configResolvers[1]?.({ data: { model: 'new/model' } });
    expect(await second).toEqual({ model: 'new/model' });
    expect(await third).toEqual({ model: 'new/model' });

    const cached = await opencodeClient.getConfig('/workspace/project');
    expect(cached).toEqual({ model: 'new/model' });
    expect(configCalls).toBe(2);
  });
});

describe('opencodeClient prompt retry behavior', () => {
  const sendPrompt = (providerID = 'anthropic') => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('does not retry 504 prompt responses because the POST may already be accepted', async () => {
    promptAsyncResults.push({ response: new Response('gateway timeout', { status: 504 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-504');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (504)');
  });

  test('does not retry transport failures because the tunnel may have lost only the response', async () => {
    promptAsyncResults.push(new TypeError('Failed to fetch'));

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-network');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to fetch');
  });

  test('does not fabricate an HTTP 500 when the SDK swallows a transport failure into result.error', async () => {
    // The SDK catches thrown fetch errors and returns { error, response: undefined }.
    // That is a transport failure, not a server 500 — it must surface as a
    // descriptive transport error, never as "Failed to send message (500): {}".
    promptAsyncResults.push({ error: new TypeError('relay tunnel reset: plaintext frame on established channel'), response: undefined });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-transport');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).not.toContain('Failed to send message (500)');
    expect(message).toContain('transport failure');
    expect(message).toContain('relay tunnel reset');
    expect((error as Error & { status?: number }).status).toBe(undefined);
  });

  test('does not retry 503 prompt responses because proxy errors can be ambiguous too', async () => {
    promptAsyncResults.push({ response: new Response('starting', { status: 503 }) });

    let error: unknown = null;
    try {
      await sendPrompt('anthropic-503');
    } catch (caught) {
      error = caught;
    }

    expect(promptAsyncCalls.length).toBe(1);
    expect(error instanceof Error ? error.message : String(error)).toContain('Failed to send message (503)');
  });

  test('does not dispatch after the runtime changes while preparing attachments', async () => {
    runtimeKey = 'runtime-a';
    const pending = opencodeClient.sendMessage({
      id: 'ses_runtime_race',
      providerID: 'runtime-race-provider',
      modelID: 'model-a',
      text: 'hello',
      runtimeKey: 'runtime-a',
      files: [{
        type: 'file',
        mime: 'text/markdown',
        filename: 'notes.md',
        url: 'data:text/markdown,hello',
      }],
    });

    runtimeKey = 'runtime-b';

    let error: unknown = null;
    try {
      await pending;
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(Error);
    expect(error instanceof Error ? error.message : String(error)).toContain('runtime changed');
    expect(promptAsyncCalls).toHaveLength(0);
  });
});

describe('opencodeClient sendMessage system pass-through', () => {
  const send = (system?: string) => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID: 'anthropic',
    modelID: 'claude-sonnet',
    text: 'hello',
    messageId: 'msg_fixed',
    ...(system !== undefined ? { system } : {}),
  });

  test('a normal send carries no system field and is unchanged by the extension', async () => {
    await send();
    const body = promptAsyncBody(0);
    expect(Object.prototype.hasOwnProperty.call(body, 'system')).toBe(false);
    expect(Object.keys(body).sort()).toEqual([
      'agent',
      'messageID',
      'model',
      'parts',
      'sessionID',
      'variant',
    ]);
  });

  test('a provided system is forwarded and only the system field differs', async () => {
    await send();
    await send('advisor hint for exactly this turn');
    const plainBody = promptAsyncBody(0);
    const hintedBody = promptAsyncBody(1);
    expect(hintedBody.system).toBe('advisor hint for exactly this turn');
    const rest = { ...hintedBody };
    delete rest.system;
    expect(rest).toEqual(plainBody);
    expect(Object.keys(hintedBody).sort()).toEqual([...Object.keys(plainBody), 'system'].sort());
  });
});

describe('opencodeClient sendMessage part-metadata pass-through', () => {
  type TextPartMetadataFixture = {
    openchamberConsultReceipt: { runID: string; degraded: boolean };
  };

  type PartMetadataSendParams = {
    id: string;
    providerID: string;
    modelID: string;
    text: string;
    messageId: string;
    files: Array<{ type: 'file'; mime: string; filename: string; url: string }>;
    additionalParts: Array<{ text: string; synthetic: boolean }>;
    agentMentions: Array<{ name: string }>;
    textPartMetadata?: TextPartMetadataFixture;
  };

  const send = (textPartMetadata?: TextPartMetadataFixture) => {
    const params: PartMetadataSendParams = {
      id: 'ses_1',
      providerID: 'anthropic',
      modelID: 'claude-sonnet',
      text: 'hello',
      messageId: 'msg_fixed',
      files: [{ type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain,hello' }],
      additionalParts: [{ text: 'attached context', synthetic: true }],
      agentMentions: [{ name: 'build' }],
    };
    if (textPartMetadata !== undefined) params.textPartMetadata = textPartMetadata;
    return opencodeClient.sendMessage(params);
  };

  test('a normal send attaches no metadata to any part', async () => {
    await send();

    const body = promptAsyncBody(0);
    expect(body.parts).toEqual([
      { type: 'text', text: 'hello' },
      { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain,hello' },
      { type: 'text', text: 'attached context', synthetic: true },
      { type: 'agent', name: 'build' },
    ]);
  });

  test('a provided metadata rides the primary text part and nothing else changes', async () => {
    const metadata: TextPartMetadataFixture = {
      openchamberConsultReceipt: { runID: 'run-1', degraded: false },
    };
    await send();
    await send(metadata);

    const plainBody = promptAsyncBody(0);
    const hintedBody = promptAsyncBody(1);
    expect(hintedBody.parts).toEqual([
      { type: 'text', text: 'hello', metadata },
      { type: 'file', mime: 'text/plain', filename: 'notes.txt', url: 'data:text/plain,hello' },
      { type: 'text', text: 'attached context', synthetic: true },
      { type: 'agent', name: 'build' },
    ]);

    const plainRest = { ...plainBody };
    delete plainRest.parts;
    const hintedRest = { ...hintedBody };
    delete hintedRest.parts;
    expect(hintedRest).toEqual(plainRest);
  });
});

describe('opencodeClient updateSession permission forwarding', () => {
  test('does not send a permission field when the patch has none', async () => {
    await opencodeClient.updateSession('ses_1', { title: 'renamed' });
    const call = sessionUpdateCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call?.title).toBe('renamed');
    expect(call && Object.prototype.hasOwnProperty.call(call, 'permission')).toBe(false);
  });

  test('forwards a permission ruleset to session.update when provided', async () => {
    const permission = [{ permission: '*', pattern: '*', action: 'deny' as const }];
    await opencodeClient.updateSession('ses_1', { permission });
    const call = sessionUpdateCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call?.sessionID).toBe('ses_1');
    expect(call?.permission).toEqual(permission);
  });

  test('an empty ruleset is forwarded as provided rather than dropped', async () => {
    await opencodeClient.updateSession('ses_1', { permission: [] });
    const call = sessionUpdateCalls[0]?.[0] as Record<string, unknown> | undefined;
    expect(call?.permission).toEqual([]);
  });
});

describe('opencodeClient provider circuit opt-out', () => {
  const advisorSend = (providerID: string) => opencodeClient.sendMessage({
    id: 'ses_advisor',
    providerID,
    modelID: 'advisor-model',
    text: 'advise',
    trackProviderErrors: false,
  });

  const ordinarySend = (providerID: string) => opencodeClient.sendMessage({
    id: 'ses_1',
    providerID,
    modelID: 'claude-sonnet',
    text: 'hello',
  });

  test('consecutive advisor failures do not open or feed the circuit for ordinary sends', async () => {
    const providerID = 'advisor-exempt-provider';

    promptAsyncResults.push(new TypeError('Failed to fetch'));
    await expect(advisorSend(providerID)).rejects.toThrow('Failed to fetch');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      promptAsyncResults.push({ response: new Response('overloaded', { status: 503 }) });
      await expect(advisorSend(providerID)).rejects.toThrow('Failed to send message (503)');
    }

    // Ordinary accounting starts clean: two errors stay below the threshold of
    // three, so the acting send is dispatched instead of hitting an open circuit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      promptAsyncResults.push({ response: new Response('overloaded', { status: 503 }) });
      await expect(ordinarySend(providerID)).rejects.toThrow('Failed to send message (503)');
    }
    const dispatchesBefore = promptAsyncCalls.length;
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });
    await ordinarySend(providerID);
    expect(promptAsyncCalls.length).toBe(dispatchesBefore + 1);
  });

  test('advisor sends are dispatched while the circuit is open and do not close it', async () => {
    const providerID = 'advisor-open-circuit-provider';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      promptAsyncResults.push({ response: new Response('overloaded', { status: 503 }) });
      await expect(ordinarySend(providerID)).rejects.toThrow('Failed to send message (503)');
    }
    await expect(ordinarySend(providerID)).rejects.toThrow('temporarily unavailable');

    const dispatchesBefore = promptAsyncCalls.length;
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });
    await advisorSend(providerID);
    expect(promptAsyncCalls.length).toBe(dispatchesBefore + 1);

    // The advisor outcome is not recorded, so the circuit stays open for ordinary sends.
    await expect(ordinarySend(providerID)).rejects.toThrow('temporarily unavailable');
  });

  test('an ordinary success clears accumulated errors when the option is absent', async () => {
    const providerID = 'default-circuit-provider';

    for (let attempt = 0; attempt < 2; attempt += 1) {
      promptAsyncResults.push({ response: new Response('overloaded', { status: 503 }) });
      await expect(ordinarySend(providerID)).rejects.toThrow('Failed to send message (503)');
    }
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });
    await ordinarySend(providerID);

    // The success reset the counter: two more failures still do not open the circuit.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      promptAsyncResults.push({ response: new Response('overloaded', { status: 503 }) });
      await expect(ordinarySend(providerID)).rejects.toThrow('Failed to send message (503)');
    }
    const dispatchesBefore = promptAsyncCalls.length;
    promptAsyncResults.push({ response: new Response(null, { status: 200 }) });
    await ordinarySend(providerID);
    expect(promptAsyncCalls.length).toBe(dispatchesBefore + 1);
  });
});
