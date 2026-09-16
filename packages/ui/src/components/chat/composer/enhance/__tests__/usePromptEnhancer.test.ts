import { beforeEach, describe, expect, mock, test } from 'bun:test';
import React, { act } from 'react';
import { Window } from 'happy-dom';
import { createRoot } from 'react-dom/client';

// The hook reaches the network only through `enhancePrompt`; that seam is
// mocked. `@/lib/i18n` is typed-only for the hook but still loads its store,
// so it is mocked to keep the test hermetic.
mock.module('@/lib/i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

// happy-dom supplies the document identity React's host renderer needs; the
// hook under test touches no DOM beyond React's own host bookkeeping.
const win = new Window({ url: 'http://localhost' });
Object.defineProperty(globalThis, 'window', { configurable: true, value: win.window ?? win });
Object.defineProperty(globalThis, 'document', { configurable: true, value: win.document });
// SAFETY: only the boolean flag is assigned on globalThis; React's act reads
// it to decide whether state updates are inside an awaited act() scope.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The mocked PromptEnhanceError must be defined outside the mock factory so
// the hook's `instanceof` check sees the same class the thrown errors carry.
class MockPromptEnhanceError extends Error {
  readonly reason: string;
  constructor(reason: string, message: string) {
    super(message);
    this.name = 'PromptEnhanceError';
    this.reason = reason;
  }
}

// Scripted transport: each test pushes a resolution the in-flight enhance
// call awaits, so ordering across two concurrent requests stays explicit.
type ScriptedResolve = { text: string; delayMs?: number } | { error: Error; delayMs?: number };
type EnhancePromptImpl = (draft: string, context: PromptEnhanceContext, signal: AbortSignal) => Promise<string>;
let script: ScriptedResolve[] = [];
const scriptedEnhancePrompt: EnhancePromptImpl = async (_draft, _context, signal) => {
  const step = script.shift();
  if (!step) throw new Error('no scripted enhance response');
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, step.delayMs ?? 0);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      // The transport layer surfaces a cancellation as a raw DOMException-
      // shaped Error, not as the typed error — mirror that here.
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      reject(abortError);
    }, { once: true });
  });
  if ('error' in step) throw step.error;
  return step.text;
};
// A test may swap the scripted transport entirely (e.g. a raw abort that
// rejects independently of the signal); the default is restored after.
let enhancePromptImpl: EnhancePromptImpl = scriptedEnhancePrompt;
const mockEnhancePromptImplementation = (impl: EnhancePromptImpl): void => {
  enhancePromptImpl = impl;
};
const restoreEnhancePromptImplementation = (): void => {
  enhancePromptImpl = scriptedEnhancePrompt;
};

mock.module('../promptEnhancer', () => ({
  ENHANCE_INSTRUCTIONS_ID: 'composer.enhance.instructions',
  PromptEnhanceError: MockPromptEnhanceError,
  enhancePrompt: (draft: string, context: PromptEnhanceContext, signal: AbortSignal): Promise<string> =>
    enhancePromptImpl(draft, context, signal),
}));

import { usePromptEnhancer } from '../usePromptEnhancer';
import type { PromptEnhanceContext } from '../promptEnhancer';
import type { ComposerLanguageContext } from '../../language/tokenize';

const languageContext: ComposerLanguageContext = {
  inputMode: 'normal',
  knownAgentNames: new Set(),
  confirmedMentions: new Set(),
  knownSlashNames: new Set(),
  knownSnippetTriggers: new Set(),
  attachmentFilenames: [],
};

const enhanceContext = { directory: '/repo', sessionId: null };

/** The hook's result, as ChatInput consumes it. */
type EnhanceOutcome = Awaited<ReturnType<ReturnType<typeof usePromptEnhancer>['enhance']>>;

interface Harness {
  isEnhancing: () => boolean;
  /** Runs one enhance to settlement and resolves its outcome. */
  enhance: (draft: string) => Promise<EnhanceOutcome>;
  /** Starts an enhance without awaiting; resolves the hook's raw promise. */
  startEnhance: (draft: string) => Promise<EnhanceOutcome>;
  cancel: () => void;
  unmount: () => void;
  /** Swaps the language context the hook is rendered with, as a re-render would. */
  setLanguageContext: (next: ComposerLanguageContext) => void;
}

function renderHarness(initialContext: ComposerLanguageContext = languageContext): Harness {
  const container = document.createElement('div');
  const root = createRoot(container);
  let captured: {
    isEnhancing: boolean;
    enhance: (draft: string, context: typeof enhanceContext) => Promise<EnhanceOutcome>;
    cancel: () => void;
  } | null = null;
  // Read at render time so tests can swap the context the way ChatInput does:
  // its languageContext memo returns a fresh object whenever its inputs
  // recompute, so a re-render can hand the hook a rebuilt object.
  let currentContext = initialContext;

  function Probe() {
    const hook = usePromptEnhancer(currentContext);
    captured = { isEnhancing: hook.isEnhancing, enhance: hook.enhance, cancel: hook.cancel };
    return null;
  }

  act(() => { root.render(React.createElement(Probe)); });
  const getEnhance = () => {
    if (!captured) throw new Error('hook was not rendered');
    return captured.enhance;
  };
  return {
    isEnhancing: () => captured?.isEnhancing ?? false,
    enhance: async (draft: string) => {
      // React's act thenable resolves before the callback's continuation
      // runs, so the result must be read after awaiting act, never through
      // a chained .then.
      let result: EnhanceOutcome | undefined;
      await act(async () => {
        result = await getEnhance()(draft, enhanceContext);
      });
      // SAFETY: the awaited act callback settled the enhance before returning.
      return result!;
    },
    startEnhance: (draft: string) => getEnhance()(draft, enhanceContext),
    cancel: () => { act(() => { captured?.cancel(); }); },
    unmount: () => { act(() => { root.unmount(); }); },
    setLanguageContext: (next: ComposerLanguageContext) => {
      currentContext = next;
      act(() => { root.render(React.createElement(Probe)); });
    },
  };
}

beforeEach(() => {
  script = [];
});

describe('usePromptEnhancer', () => {
  test('a successful enhance applies the rewrite to the unchanged draft', async () => {
    script = [{ text: 'improved draft' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('improved draft');
        expect(result.sourceSnapshot).toBe('my draft');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a response landing after a rebuilt-but-equal context still applies', async () => {
    // ChatInput rebuilds its languageContext memo whenever its inputs
    // recompute — including the setIsEnhancing(true) render that starts the
    // request. Staleness is judged by the registry values, not object
    // identity, so this response must apply.
    script = [{ text: 'improved draft', delayMs: 30 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.setLanguageContext({
        inputMode: 'normal',
        knownAgentNames: new Set(),
        confirmedMentions: new Set(),
        knownSlashNames: new Set(),
        knownSnippetTriggers: new Set(),
        attachmentFilenames: [],
      });
      const result = await promise;
      // settle() flips isEnhancing outside act (the promise resolves before
      // React flushes), so flush once before asserting the spinner state.
      await act(async () => {});
      expect(result.outcome).toBe('applied');
      if (result.outcome === 'applied') {
        expect(result.text).toBe('improved draft');
        expect(result.sourceSnapshot).toBe('my draft');
      }
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a response landing after a materially changed context stays stale', async () => {
    // A registry change (here: shell mode) between request and response means
    // the rewrite answered for a different composer language — stale.
    script = [{ text: 'improved draft', delayMs: 30 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.setLanguageContext({
        inputMode: 'shell',
        knownAgentNames: new Set(),
        confirmedMentions: new Set(),
        knownSlashNames: new Set(),
        knownSnippetTriggers: new Set(),
        attachmentFilenames: [],
      });
      const result = await promise;
      await act(async () => {});
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a rewrite that loses a protected mention fails as invalid-result', async () => {
    script = [{ text: 'improved draft without the token' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('fix @src/auth.ts');
      expect(result).toEqual({ outcome: 'failed', reason: 'invalid-result' });
    } finally {
      harness.unmount();
    }
  });

  test('a rewrite that invents a protected token fails as invalid-result', async () => {
    script = [{ text: 'improved draft #snippet' }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('plain draft text');
      expect(result).toEqual({ outcome: 'failed', reason: 'invalid-result' });
    } finally {
      harness.unmount();
    }
  });

  test('a failure keeps the outcome with its reason and no text', async () => {
    script = [{ error: new MockPromptEnhanceError('empty-result', 'empty') }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result.outcome).toBe('failed');
      if (result.outcome === 'failed') {
        expect(result.reason).toBe('empty-result');
        expect('text' in result).toBe(false);
      }
    } finally {
      harness.unmount();
    }
  });

  test('a deadline failure surfaces as timed-out, not stale', async () => {
    // The service maps a fired deadline to the typed reason; the hook must
    // pass it through so ChatInput can toast it (unlike a silent abort).
    script = [{ error: new MockPromptEnhanceError('timed-out', 'deadline') }];
    const harness = renderHarness();
    try {
      const result = await harness.enhance('my draft');
      expect(result).toEqual({ outcome: 'failed', reason: 'timed-out' });
    } finally {
      harness.unmount();
    }
  });

  test('a raw transport abort resolves silently as stale', async () => {
    // The mocked transport rejects with a plain Error named AbortError — the
    // shape a fetch cancellation surfaces when it bypasses the service layer.
    // SAFETY: the holder only ever stores the mocked promise's reject fn.
    const rejectHolder = { reject: undefined as ((error: Error) => void) | undefined };
    mockEnhancePromptImplementation(() => new Promise<string>((_resolve, reject) => {
      rejectHolder.reject = reject;
    }));
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.cancel();
      const abortError = new Error('The operation was aborted.');
      abortError.name = 'AbortError';
      rejectHolder.reject?.(abortError);
      const result = await promise;
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
      restoreEnhancePromptImplementation();
    }
  });

  test('cancel during flight resolves silently and never applies', async () => {
    script = [{ text: 'late rewrite', delayMs: 50 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.cancel();
      const result = await promise;
      expect(result.outcome).toBe('stale');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a second enhance invalidates the first (first resolves late → stale)', async () => {
    script = [
      { text: 'first rewrite', delayMs: 50 },
      { text: 'second rewrite' },
    ];
    const harness = renderHarness();
    try {
      const firstPromise = harness.startEnhance('first draft');
      const second = await harness.enhance('second draft');
      expect(second.outcome).toBe('applied');
      if (second.outcome === 'applied') {
        expect(second.text).toBe('second rewrite');
      }
      const first = await firstPromise;
      expect(first.outcome).toBe('stale');
    } finally {
      harness.unmount();
    }
  });

  test('isEnhancing turns off once the request settles', async () => {
    script = [{ text: 'rewrite' }];
    const harness = renderHarness();
    try {
      expect(harness.isEnhancing()).toBe(false);
      await harness.enhance('my draft');
      expect(harness.isEnhancing()).toBe(false);
    } finally {
      harness.unmount();
    }
  });

  test('a late response after unmount resolves stale, not applied', async () => {
    script = [{ text: 'late rewrite', delayMs: 50 }];
    const harness = renderHarness();
    try {
      const promise = harness.startEnhance('my draft');
      harness.unmount();
      const result = await promise;
      expect(result.outcome).toBe('stale');
    } finally {
      // Idempotent for the already-unmounted root.
      harness.unmount();
    }
  });
});
