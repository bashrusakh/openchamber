import { beforeEach, afterEach, describe, expect, mock, test } from 'bun:test';
import type { Agent, Message, SessionStatus } from '@opencode-ai/sdk/v2';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ChildStoreManager } from '@/sync/child-store';
import type { State } from '@/sync/types';
import { getDirectoryState, setSyncRefs } from '@/sync/sync-refs';
import { createMessageQueueTarget, useMessageQueueStore, type QueuedMessage } from '../stores/messageQueueStore';
import { getRuntimeKey } from '@/lib/runtime-switch';

let visibleAgents: Agent[] = [];
const sendMessageCalls: unknown[][] = [];

const getVisibleAgentsMock = mock(() => visibleAgents);

mock.module('@/stores/useConfigStore', () => ({
  useConfigStore: {
    getState: () => ({
      getVisibleAgents: getVisibleAgentsMock,
    }),
  },
}));

mock.module('@/sync/session-ui-store', () => ({
  useSessionUIStore: {
    getState: () => ({
      sendMessage: (...args: unknown[]) => {
        sendMessageCalls.push(args);
        return Promise.resolve();
      },
      sessionAbortFlags: new Map(),
    }),
  },
}));

type AutoReviewRunStub = {
  status: 'running' | 'completed' | 'stopped' | 'error';
};

type AutoReviewStateStub = {
  runsByOriginalSessionID: Record<string, AutoReviewRunStub>;
  isRunningForSession: (sessionId: string) => boolean;
};

const autoReviewMockState: AutoReviewStateStub = {
  runsByOriginalSessionID: {},
  isRunningForSession: (sessionId) => autoReviewMockState.runsByOriginalSessionID[sessionId]?.status === 'running',
};

const useAutoReviewStoreMock = Object.assign(
  <T,>(selector: (state: AutoReviewStateStub) => T): T => selector(autoReviewMockState),
  { getState: (): AutoReviewStateStub => autoReviewMockState },
);

mock.module('@/stores/useAutoReviewStore', () => ({
  useAutoReviewStore: useAutoReviewStoreMock,
}));

// The hook reads live status two ways: the effect loop subscribes through
// useDirectorySync, and the dispatch-time re-check reads the directory child
// store via getSyncRefs' getDirectoryState. Back the useDirectorySync mock
// with the same real child store so both observations share one source of
// truth and a status flip drives the effect like a live snapshot would.
const DIRECTORY = '/repo-auto';

const EMPTY_DIRECTORY_STATE: DirectorySyncState = { session_status: {}, message: {} };

// The hook only reads session_status and message from the directory state;
// these are the exact slices resolveQueuedSessionStatusType and the effect
// loop consume from the real child-store State.
type DirectorySyncState = Pick<State, 'session_status' | 'message'> & {
  session_status: Record<string, { type: 'idle' | 'busy' | 'retry' } | undefined>;
};

let directoryChildStores: ChildStoreManager | null = null;

const setDirectorySessionStatus = (sessionId: string, type: 'idle' | 'busy' | 'retry') => {
  const manager = directoryChildStores;
  const store = manager?.ensureChild(DIRECTORY, { bootstrap: false });
  if (!store) throw new Error('directory child store not bootstrapped');
  const status: SessionStatus = type === 'busy' ? { type: 'busy' } : type === 'retry' ? { type: 'retry', attempt: 1, message: 'test', next: 0 } : { type: 'idle' };
  store.setState({ status: 'complete', session_status: { [sessionId]: status }, message: {} });
};

const readDirectorySyncState = (): DirectorySyncState => {
  // SAFETY: getDirectoryState returns the real child-store State; the test
  // only writes idle/busy/retry entries and Message objects through
  // setDirectorySessionStatus/store.setState, so the state it reads back is
  // exactly the DirectorySyncState slice shape this mock hands to selectors.
  const state = getDirectoryState(DIRECTORY) as DirectorySyncState | undefined;
  return state ?? EMPTY_DIRECTORY_STATE;
};

// The real useDirectorySync passes the selector's own generic through, so the
// mock mirrors that contract instead of forcing selectors to unknown.
mock.module('@/sync/sync-context', () => ({
  useDirectorySync: <T,>(selector: (state: DirectorySyncState) => T): T => selector(readDirectorySyncState()),
}));

mock.module('@/stores/useDirectoryStore', () => ({
  useDirectoryStore: <T,>(selector: (state: { currentDirectory: string }) => T): T =>
    selector({ currentDirectory: DIRECTORY }),
}));

import {
  buildQueuedAutoSendPayload,
  createQueuedAutoSendRetryScheduler,
  getQueuedAutoSendRetryDelayMs,
  isQueuedAutoSendBackedOff,
  resolveQueuedSessionStatusType,
  sendQueuedAutoSendPayload,
  shouldDispatchQueuedAutoSend,
  useQueuedMessageAutoSend,
} from './useQueuedMessageAutoSend';

describe('queued auto-send retry scheduler', () => {
  test('wakes the queue when backoff expires', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    let wakeups = 0;
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => { wakeups += 1; },
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        expect(delay).toBe(500);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(1_500);
    expect(callbacks.size).toBe(1);
    callbacks.values().next().value?.();
    expect(wakeups).toBe(1);
  });

  test('keeps the earliest retry and cancels it on dispose', () => {
    const callbacks = new Map<number, () => void>();
    let nextTimer = 0;
    const delays: number[] = [];
    const scheduler = createQueuedAutoSendRetryScheduler(
      () => undefined,
      () => 1_000,
      (callback, delay) => {
        callbacks.set(++nextTimer, callback);
        delays.push(delay);
        return nextTimer as unknown as ReturnType<typeof setTimeout>;
      },
      (timer) => { callbacks.delete(timer as unknown as number); },
    );

    scheduler.schedule(3_000);
    scheduler.schedule(4_000);
    scheduler.schedule(2_000);

    expect(delays).toEqual([2_000, 1_000]);
    expect(callbacks.size).toBe(1);
    scheduler.dispose();
    expect(callbacks.size).toBe(0);
  });
});

describe('shouldDispatchQueuedAutoSend', () => {
  test('dispatches only after an active session becomes idle', () => {
    expect(shouldDispatchQueuedAutoSend('busy', 'idle', false)).toBe(true);
    expect(shouldDispatchQueuedAutoSend('retry', 'idle', false)).toBe(true);
  });

  test('does not dispatch when idle is only first seen or status is missing', () => {
    expect(shouldDispatchQueuedAutoSend(undefined, 'idle', false)).toBe(false);
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', false)).toBe(false);
  });

  test('dispatches when idle→idle and queue has items', () => {
    expect(shouldDispatchQueuedAutoSend('idle', 'idle', true)).toBe(true);
  });
});

describe('queued auto-send retry backoff', () => {
  test('delay grows exponentially and is capped', () => {
    expect(getQueuedAutoSendRetryDelayMs(1)).toBe(2000);
    expect(getQueuedAutoSendRetryDelayMs(2)).toBe(4000);
    expect(getQueuedAutoSendRetryDelayMs(3)).toBe(8000);
    expect(getQueuedAutoSendRetryDelayMs(10)).toBe(60000);
    expect(getQueuedAutoSendRetryDelayMs(100)).toBe(60000);
  });

  test('backs off only the failed message within its window', () => {
    const failure = { messageId: 'queued-1', failures: 1, nextAttemptAt: 10_000 };

    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 9_999)).toBe(true);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-1', 10_000)).toBe(false);
    expect(isQueuedAutoSendBackedOff(failure, 'queued-2', 9_999)).toBe(false);
    expect(isQueuedAutoSendBackedOff(undefined, 'queued-1', 0)).toBe(false);
  });
});

describe('resolveQueuedSessionStatusType', () => {
  const DIRECTORY = '/repo';

  const assistantMessage = (id: string, completed?: number): Message => ({
    id,
    role: 'assistant',
    sessionID: 'ses_1',
    time: { created: 1, ...(completed !== undefined ? { completed } : {}) },
  } as Message);

  let childStores: ChildStoreManager;

  beforeEach(() => {
    childStores = new ChildStoreManager();
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ status: 'complete', session_status: {}, message: {} });
    setSyncRefs({} as never, childStores, DIRECTORY);
  });

  test('treats a session with an in-flight assistant turn as busy even when the status entry is missing', () => {
    // The server status map only lists busy/retry sessions, so a missed busy
    // event leaves NO status entry while the turn is still streaming. The
    // queue gate must not read that absence as idle: queued prompts would be
    // dispatched into the running turn and merged into one model response.
    childStores.ensureChild(DIRECTORY, { bootstrap: false }).setState({
      message: { ses_1: [assistantMessage('msg_streaming')] },
    });

    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
  });

  test('resolves an explicit busy or retry status entry', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'busy' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('busy');
    store.setState({ session_status: { ses_1: { type: 'retry', attempt: 2, message: 'boom', next: 30 } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('retry');
  });

  test('resolves idle when the trailing assistant message has completed', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ message: { ses_1: [assistantMessage('msg_done', 5)] } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
  });

  test('resolves an explicit idle entry and unknown sessions as idle', () => {
    const store = childStores.ensureChild(DIRECTORY, { bootstrap: false });
    store.setState({ session_status: { ses_1: { type: 'idle' } } });
    expect(resolveQueuedSessionStatusType('ses_1', DIRECTORY)).toBe('idle');
    expect(resolveQueuedSessionStatusType('ses_unknown', DIRECTORY)).toBe('idle');
  });
});

describe('buildQueuedAutoSendPayload', () => {
  beforeEach(() => {
    visibleAgents = [];
    sendMessageCalls.length = 0;
  });

  test('returns only the first queued message for auto-send', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-1',
        content: 'first queued message',
        createdAt: 1,
      },
      {
        id: 'queued-2',
        content: 'second queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-1');
    expect(payload?.primaryText).toBe('first queued message');
    expect(payload?.primaryAttachments).toEqual([]);
  });

  test('uses the configured visible agents when parsing queued mentions', () => {
    visibleAgents = [
      {
        name: 'Builder',
        mode: 'subagent',
        permission: [],
        options: {},
      } as Agent,
    ];

    const queue: QueuedMessage[] = [
      {
        id: 'queued-mention',
        content: '@Builder please take this',
        createdAt: 1,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.agentMentionName).toBe('Builder');
    expect(payload?.primaryText).toBe('@Builder please take this');
  });

  test('preserves attachment-only queued messages as sendable payloads', () => {
    const queue: QueuedMessage[] = [
      {
        id: 'queued-attachments',
        content: '',
        createdAt: 1,
        attachments: [
          {
            id: 'file-1',
            filename: 'notes.txt',
            mimeType: 'text/plain',
            size: 5,
            source: 'local',
            file: new File(['hello'], 'notes.txt', { type: 'text/plain' }),
            dataUrl: 'data:text/plain;base64,aGVsbG8=',
          },
        ],
      },
      {
        id: 'queued-2',
        content: 'later queued message',
        createdAt: 2,
      },
    ];

    const payload = buildQueuedAutoSendPayload(queue);

    expect(payload).not.toBeNull();
    expect(payload?.queuedMessageId).toBe('queued-attachments');
    expect(payload?.primaryText).toBe('');
    expect(payload?.primaryAttachments).toHaveLength(1);
    expect(payload?.primaryAttachments[0]?.filename).toBe('notes.txt');
  });

  test('auto-send targets the queued session explicitly', async () => {
    const payload = buildQueuedAutoSendPayload([
      {
        id: 'queued-1',
        content: 'queued message',
        createdAt: 1,
      },
    ]);

    expect(payload).not.toBeNull();
    await sendQueuedAutoSendPayload({
      runtimeKey: 'runtime-original',
      sessionId: 'session-original',
      directory: '/repo',
    }, payload!, {
      providerID: 'provider-1',
      modelID: 'model-1',
      agent: 'agent-1',
      variant: 'variant-1',
    });

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]).toEqual([
      'queued message',
      'provider-1',
      'model-1',
      'agent-1',
      [],
      undefined,
      undefined,
      'variant-1',
      'normal',
      {
        target: {
          runtimeKey: 'runtime-original',
          sessionId: 'session-original',
          directory: '/repo',
        },
      },
    ]);
  });
});

describe('useQueuedMessageAutoSend integration', () => {
  let windowInstance: Window;
  let host: HTMLDivElement;
  let root: Root;

  const HookHost = () => {
    useQueuedMessageAutoSend(true);
    return null;
  };

  const mountHook = async () => {
    await act(async () => {
      root.render(React.createElement(HookHost));
    });
  };

  const rerenderHook = async () => {
    await act(async () => {
      root.render(React.createElement(HookHost));
    });
  };

  const primeQueue = (sessionId: string) => {
    const target = createMessageQueueTarget(sessionId, DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    // Send config captured at queue time — the hook must send with this exact
    // configuration instead of re-resolving from current config stores.
    useMessageQueueStore.getState().addToQueue(target, {
      content: 'queued prompt',
      sendConfig: { providerID: 'provider-1', modelID: 'model-1' },
    });
    return target;
  };

  const queueOf = (sessionId: string): QueuedMessage[] => {
    const target = createMessageQueueTarget(sessionId, DIRECTORY, getRuntimeKey());
    if (!target) throw new Error('queue target derivation failed');
    return useMessageQueueStore.getState().getQueueForTarget(target);
  };

  beforeEach(() => {
    windowInstance = new Window();

    Object.assign(globalThis, {
      window: windowInstance,
      document: windowInstance.document,
      HTMLElement: windowInstance.HTMLElement,
      Element: windowInstance.Element,
      Node: windowInstance.Node,
      PointerEvent: windowInstance.PointerEvent,
      IS_REACT_ACT_ENVIRONMENT: true,
    });

    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);

    visibleAgents = [];
    sendMessageCalls.length = 0;
    directoryChildStores = new ChildStoreManager();
    // SAFETY: setSyncRefs only stores the sdk reference, never calls it; the
    // hook under test reads child-store state exclusively, so an empty stub
    // client is never dereferenced.
    setSyncRefs({} as never, directoryChildStores, DIRECTORY);
    setDirectorySessionStatus('ses_auto', 'busy');
    useMessageQueueStore.setState({
      queuedMessages: {},
      sendingIds: {},
      quarantinedLegacyMessages: {},
    });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    windowInstance.close();
  });

  test('dispatches the first queued item when a busy session turns idle and removes it from the queue', async () => {
    primeQueue('ses_auto');
    await mountHook();
    expect(sendMessageCalls.length).toBe(0);

    act(() => {
      setDirectorySessionStatus('ses_auto', 'idle');
    });
    await rerenderHook();

    expect(sendMessageCalls.length).toBe(1);
    expect(sendMessageCalls[0]?.[0]).toBe('queued prompt');
    expect(queueOf('ses_auto')).toHaveLength(0);
  });

  test('keeps the queue intact while the session stays busy across renders', async () => {
    primeQueue('ses_auto');
    await mountHook();

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await rerenderHook();
      expect(sendMessageCalls.length).toBe(0);
    }

    expect(queueOf('ses_auto')).toHaveLength(1);
  });
});
