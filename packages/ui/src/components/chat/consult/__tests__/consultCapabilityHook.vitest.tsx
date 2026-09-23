import React, { act } from 'react';
import { expect, mock, test } from 'bun:test';

import type { ConsultMechanismCapability } from '@/lib/consult/capability';
import { installConsultTestDom } from './consultTestDom';

/**
 * The live capability hook against the real gate (runtime-switch regression).
 *
 * `runtimeFetch` is the hook's only I/O seam: the mock hands out one deferred
 * response per call, so the test can hold a check pending, assert the
 * fail-closed state, and resolve it deliberately.
 */

type DeferredFetch = {
  promise: Promise<Response>;
  resolve: (response: Response) => void;
};

const pendingFetches: DeferredFetch[] = [];
let fetchCalls = 0;

const nextFetch = (): DeferredFetch => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((settle) => { resolve = settle; });
  const entry = { promise, resolve };
  pendingFetches.push(entry);
  return entry;
};

const verifiedServerPayload = (): Response => new Response(
  JSON.stringify({ version: '1.18.31', consultProtocol: 2 }),
  { status: 200, headers: { 'Content-Type': 'application/json' } },
);

mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: (): Promise<Response> => {
    fetchCalls += 1;
    const entry = pendingFetches.shift();
    if (!entry) throw new Error('runtimeFetch called without a pending response');
    return entry.promise;
  },
}));

test('a runtime endpoint change fails the live capability closed and refetches', async () => {
  const restoreDom = installConsultTestDom();
  const { createRoot } = await import('react-dom/client');
  const { useConsultLiveCapability } = await import('../consultUi');
  const { switchRuntimeEndpoint } = await import('@/lib/runtime-switch');

  let latest: ConsultMechanismCapability | null = null;
  const Probe = () => {
    const { capability } = useConsultLiveCapability();
    latest = capability;
    return null;
  };

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  try {
    const first = nextFetch();
    await act(async () => {
      root.render(<Probe />);
    });
    expect(latest).toEqual({ available: false, reason: 'checking-version' });

    await act(async () => {
      first.resolve(verifiedServerPayload());
    });
    expect(latest).toEqual({ available: true, assurance: 'verified', version: '1.18.31' });
    expect(fetchCalls).toBe(1);

    const second = nextFetch();
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:9999' });
    });
    expect(latest).toEqual({ available: false, reason: 'checking-version' });

    await act(async () => {
      second.resolve(verifiedServerPayload());
    });
    expect(latest).toEqual({ available: true, assurance: 'verified', version: '1.18.31' });
    expect(fetchCalls).toBe(2);

    await act(async () => {
      root.unmount();
    });
    nextFetch();
    await act(async () => {
      switchRuntimeEndpoint({ apiBaseUrl: 'http://localhost:9999' });
    });
    // The unmounted hook unsubscribed: no further capability check runs.
    expect(fetchCalls).toBe(2);
    expect(pendingFetches).toHaveLength(1);
  } finally {
    restoreDom();
  }
});
