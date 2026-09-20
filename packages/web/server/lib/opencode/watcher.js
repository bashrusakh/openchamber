import { createUpstreamSseReader } from '../event-stream/upstream-reader.js';

// Hub work events that can start or continue upstream work restart the
// directory's idle-eviction window (issue #3768, plan decision 8). Without
// this, a long turn with no proxied client traffic lets the idle window expire
// mid-turn and the instance is released right after it ends. Everything else
// is deliberately excluded: idle LSP, file-watcher, installation, presence,
// and disposal events keep arriving while nothing is running, so stamping them
// would keep instances resident forever.
const WORK_EVENT_PREFIXES = ['session.', 'message.', 'permission.', 'question.'];

export const createOpenCodeWatcherRuntime = (deps) => {
  const {
    waitForOpenCodePort,
    buildOpenCodeUrl,
    getOpenCodeAuthHeaders,
    onPayload,
    // Optional (#3768): called with the envelope directory of a work event so
    // the directory's idle window restarts.
    onDirectoryActivity = null,
    fetchImpl = fetch,
    upstreamStallTimeoutMs,
    upstreamReconnectDelayMs = 1000,
    globalEventHub = null,
  } = deps;

  let abortController = null;
  let reader = null;
  let unsubscribeEvent = null;
  let unsubscribeStatus = null;

  const unwrapGlobalEventPayload = (eventData) => {
    if (!eventData || typeof eventData !== 'object') {
      return null;
    }

    if (eventData.payload && typeof eventData.payload === 'object') {
      return eventData.payload;
    }

    return eventData;
  };

  // Best-effort and never awaited: a missing, throwing, or rejecting stamp must
  // not delay, reorder, or skip `onPayload`, and must not disturb the shared
  // hub's subscriber loop. Only work events that carry an envelope directory
  // are stamped; `'global'` and directory-less events are ignored.
  const stampDirectoryActivity = (event, payload) => {
    if (!onDirectoryActivity) {
      return;
    }

    try {
      const directory = event?.directory;
      if (!directory || directory === 'global' || String(directory) !== directory) {
        return;
      }

      const type = payload?.type;
      if (!type?.startsWith) {
        return;
      }
      if (!WORK_EVENT_PREFIXES.some((prefix) => type.startsWith(prefix))) {
        return;
      }

      Promise.resolve(onDirectoryActivity(directory)).catch(() => {});
    } catch {
    }
  };

  const start = async () => {
    if (abortController) {
      return;
    }

    await waitForOpenCodePort();

    abortController = new AbortController();
    const signal = abortController.signal;

    if (globalEventHub) {
      unsubscribeEvent = globalEventHub.subscribeEvent((event) => {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        stampDirectoryActivity(event, payload);
        onPayload(payload);
      });
      unsubscribeStatus = globalEventHub.subscribeStatus((status) => {
        if (signal.aborted) {
          return;
        }
        if (status.type === 'connect') {
          console.log('[PushWatcher] connected');
          return;
        }
        if (status.type === 'error' || status.type === 'initial-error') {
          console.warn('[PushWatcher] disconnected', status.error?.error?.message ?? status.error?.message ?? status.error);
        }
      });
      globalEventHub.start();
      return;
    }

    reader = createUpstreamSseReader({
      signal,
      buildUrl: () => buildOpenCodeUrl('/global/event', ''),
      getHeaders: getOpenCodeAuthHeaders,
      fetchImpl,
      stallTimeoutMs: upstreamStallTimeoutMs,
      reconnectDelayMs: upstreamReconnectDelayMs,
      onConnect() {
        console.log('[PushWatcher] connected');
      },
      onEvent(event) {
        const payload = unwrapGlobalEventPayload(event.payload);
        if (!payload || typeof payload !== 'object') {
          return;
        }
        stampDirectoryActivity(event, payload);
        onPayload(payload);
      },
      onError(error) {
        if (signal.aborted) {
          return;
        }
        console.warn('[PushWatcher] disconnected', error?.error?.message ?? error?.message ?? error);
      },
    });

    void reader.start();
  };

  const stop = () => {
    if (!abortController) {
      return;
    }
    try {
      abortController.abort();
      reader?.stop();
      unsubscribeEvent?.();
      unsubscribeStatus?.();
    } catch {
    }
    reader = null;
    unsubscribeEvent = null;
    unsubscribeStatus = null;
    abortController = null;
  };

  return {
    start,
    stop,
  };
};
