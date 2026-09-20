import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGlobalMessageStreamHub } from '../event-stream/global-hub.js';
import { createDirectoryActivityRuntime } from './directory-activity-runtime.js';
import { createOpenCodeWatcherRuntime } from './watcher.js';

const identityRealpath = async (value) => value;

const flushAsync = () => new Promise((resolve) => setTimeout(resolve, 0));

const createClock = (start = 1_000_000) => {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
};

const createFakeHub = () => {
  const eventSubscribers = new Set();
  const statusSubscribers = new Set();
  return {
    hub: {
      start() {},
      stop() {},
      subscribeEvent(subscriber) {
        eventSubscribers.add(subscriber);
        return () => {
          eventSubscribers.delete(subscriber);
        };
      },
      subscribeStatus(subscriber) {
        statusSubscribers.add(subscriber);
        return () => {
          statusSubscribers.delete(subscriber);
        };
      },
    },
    emit(event) {
      for (const subscriber of Array.from(eventSubscribers)) {
        subscriber(event);
      }
    },
  };
};

function createSseResponse({ blocks = [], signal, holdOpen = false }) {
  const encoder = new TextEncoder();
  let index = 0;

  return {
    ok: true,
    status: 200,
    body: {
      getReader() {
        return {
          async read() {
            if (index < blocks.length) {
              return { value: encoder.encode(blocks[index++]), done: false };
            }

            if (!holdOpen) {
              return { value: undefined, done: true };
            }

            return new Promise((_resolve, reject) => {
              const onAbort = () => {
                signal.removeEventListener('abort', onAbort);
                const error = new Error('Aborted');
                error.name = 'AbortError';
                reject(error);
              };
              signal.addEventListener('abort', onAbort, { once: true });
            });
          },
        };
      },
    },
  };
}

describe('createOpenCodeWatcherRuntime', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('waits for OpenCode readiness and forwards unwrapped global SSE payloads', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    const fetchCalls = [];

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
      },
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({ Authorization: 'Bearer test-token' }),
      onPayload(payload) {
        payloads.push(payload);
        watcher.stop();
      },
      fetchImpl: async (url, options) => {
        fetchCalls.push({ url, headers: options.headers });
        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
          ],
        });
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(fetchCalls).toEqual([
      {
        url: 'http://127.0.0.1:4096/global/event',
        headers: {
          Accept: 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          Authorization: 'Bearer test-token',
        },
      },
    ]);
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
  });

  it('resumes watcher reconnects with Last-Event-ID after a stalled upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetchLastEventIds = [];
    const payloads = [];
    let attempt = 0;

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onPayload(payload) {
        payloads.push(payload.type);
        if (payload.type === 'session.updated') {
          watcher.stop();
        }
      },
      fetchImpl: async (_url, options) => {
        fetchLastEventIds.push(options.headers['Last-Event-ID'] ?? null);
        attempt += 1;

        if (attempt === 1) {
          return createSseResponse({
            signal: options.signal,
            holdOpen: true,
            blocks: [
              'id: evt-1\ndata: {"type":"server.connected","properties":{}}\n\n',
            ],
          });
        }

        return createSseResponse({
          signal: options.signal,
          blocks: [
            'id: evt-2\ndata: {"type":"session.updated","properties":{}}\n\n',
          ],
        });
      },
      upstreamStallTimeoutMs: 10,
      upstreamReconnectDelayMs: 0,
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(payloads).toEqual(['server.connected', 'session.updated']);
    expect(fetchLastEventIds.slice(0, 2)).toEqual([null, 'evt-1']);
  });

  it('subscribes to a shared global event hub instead of opening its own upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const payloads = [];
    let hubFetchCalls = 0;
    let watcherFetchCalls = 0;

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => {
        hubFetchCalls += 1;
        return createSseResponse({
          signal: options.signal,
          holdOpen: true,
          blocks: [
            'id: evt-1\ndata: {"payload":{"type":"session.updated","properties":{"sessionID":"ses_1"}}}\n\n',
          ],
        });
      },
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload(payload) {
        payloads.push(payload);
        watcher.stop();
      },
      fetchImpl: async () => {
        watcherFetchCalls += 1;
        throw new Error('watcher fetch should not be called');
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(hubFetchCalls).toBe(1);
    expect(watcherFetchCalls).toBe(0);
    expect(payloads).toEqual([
      {
        type: 'session.updated',
        properties: {
          sessionID: 'ses_1',
        },
      },
    ]);
  });

  it('does not stop a shared global event hub when the watcher stops', async () => {
    const events = new Set();
    const statuses = new Set();
    let startCalls = 0;
    let stopCalls = 0;

    const globalEventHub = {
      start() {
        startCalls += 1;
      },
      stop() {
        stopCalls += 1;
      },
      subscribeEvent(subscriber) {
        events.add(subscriber);
        return () => {
          events.delete(subscriber);
        };
      },
      subscribeStatus(subscriber) {
        statuses.add(subscriber);
        return () => {
          statuses.delete(subscriber);
        };
      },
    };

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onPayload() {},
    });

    await watcher.start();
    watcher.stop();

    expect(startCalls).toBe(1);
    expect(stopCalls).toBe(0);
    expect(events.size).toBe(0);
    expect(statuses.size).toBe(0);
  });

  it('stamps the envelope directory of a work event delivered through the shared hub', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stamped = [];
    const payloads = [];

    const globalEventHub = createGlobalMessageStreamHub({
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      upstreamReconnectDelayMs: 0,
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        holdOpen: true,
        blocks: [
          'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"message.updated","properties":{"sessionID":"ses_1"}}}\n\n',
        ],
      }),
    });

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub,
      onDirectoryActivity(directory) {
        stamped.push(directory);
      },
      onPayload(payload) {
        payloads.push(payload.type);
      },
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stamped).toEqual(['/tmp/project']);
    expect(payloads).toEqual(['message.updated']);
    watcher.stop();
  });

  it('restarts the idle window of a tracked directory when a work event arrives', async () => {
    const clock = createClock();
    const tracker = createDirectoryActivityRuntime({ now: clock.now, realpath: identityRealpath });
    const release = await tracker.observeRequest('/tmp/project');
    release();

    const { hub, emit } = createFakeHub();
    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: hub,
      onPayload() {},
      onDirectoryActivity: (directory) => tracker.stampActivity(directory),
    });

    await watcher.start();
    clock.advance(4_000);
    emit({ directory: '/tmp/project', payload: { type: 'session.idle', properties: {} } });
    await flushAsync();

    clock.advance(1_500);
    expect(tracker.listQuietDirectories(2_000)).toEqual([]);

    clock.advance(500);
    expect(tracker.listQuietDirectories(2_000).map((entry) => entry.directory)).toEqual(['/tmp/project']);
    watcher.stop();
  });

  it('stamps every work-event family, including the v2 permission and question variants', async () => {
    const { hub, emit } = createFakeHub();
    const stamped = [];
    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: hub,
      onPayload() {},
      onDirectoryActivity(directory) {
        stamped.push(directory);
      },
    });

    await watcher.start();
    const workEvents = [
      ['session.updated', '/tmp/session'],
      ['session.next.text.delta', '/tmp/session-next'],
      ['message.part.delta', '/tmp/message'],
      ['permission.asked', '/tmp/permission'],
      ['permission.v2.replied', '/tmp/permission-v2'],
      ['question.asked', '/tmp/question'],
      ['question.v2.rejected', '/tmp/question-v2'],
    ];
    for (const [type, directory] of workEvents) {
      emit({ directory, payload: { type, properties: {} } });
    }
    await flushAsync();

    expect(stamped).toEqual(workEvents.map(([, directory]) => directory));
    watcher.stop();
  });

  it('ignores excluded event families, global envelopes, and directory-less events', async () => {
    const { hub, emit } = createFakeHub();
    const stamped = [];
    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: hub,
      onPayload() {},
      onDirectoryActivity(directory) {
        stamped.push(directory);
      },
    });

    await watcher.start();
    for (const type of [
      'lsp.updated',
      'file.watcher.updated',
      'file.edited',
      'installation.updated',
      'pty.updated',
      'todo.updated',
      'server.connected',
      'server.instance.disposed',
    ]) {
      emit({ directory: '/tmp/project', payload: { type, properties: {} } });
    }
    emit({ directory: 'global', payload: { type: 'session.updated', properties: {} } });
    emit({ payload: { type: 'session.idle', properties: {} } });
    await flushAsync();

    expect(stamped).toEqual([]);
    watcher.stop();
  });

  it('never lets a throwing or rejecting stamp skip payload forwarding', async () => {
    const { hub, emit } = createFakeHub();
    const payloads = [];
    let attempts = 0;

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      globalEventHub: hub,
      onPayload(payload) {
        payloads.push(payload.type);
      },
      onDirectoryActivity() {
        attempts += 1;
        if (attempts === 1) {
          throw new Error('sync stamp failure');
        }
        return Promise.reject(new Error('async stamp failure'));
      },
    });

    await watcher.start();
    emit({ directory: '/tmp/project', payload: { type: 'message.updated', properties: {} } });
    emit({ directory: '/tmp/project', payload: { type: 'session.idle', properties: {} } });
    await flushAsync();

    expect(payloads).toEqual(['message.updated', 'session.idle']);
    watcher.stop();
  });

  it('stamps work events read from its own upstream stream', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const stamped = [];
    const payloads = [];

    const watcher = createOpenCodeWatcherRuntime({
      waitForOpenCodePort: async () => {},
      buildOpenCodeUrl: (path) => `http://127.0.0.1:4096${path}`,
      getOpenCodeAuthHeaders: () => ({}),
      onDirectoryActivity(directory) {
        stamped.push(directory);
      },
      onPayload(payload) {
        payloads.push(payload.type);
      },
      fetchImpl: async (_url, options) => createSseResponse({
        signal: options.signal,
        blocks: [
          'id: evt-1\ndata: {"directory":"/tmp/project","payload":{"type":"session.status","properties":{}}}\n\n',
          'id: evt-2\ndata: {"directory":"/tmp/project","payload":{"type":"file.watcher.updated","properties":{}}}\n\n',
          'id: evt-3\ndata: {"payload":{"type":"session.idle","properties":{}}}\n\n',
        ],
      }),
    });

    await watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(stamped).toEqual(['/tmp/project']);
    expect(payloads).toEqual(['session.status', 'file.watcher.updated', 'session.idle']);
    watcher.stop();
  });
});
