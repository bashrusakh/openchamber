import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOctokit, withOctokitRequestSignal } from './octokit.js';

const nativeFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = nativeFetch;
});

describe('Octokit request cancellation', () => {
  it('passes the caller signal through Octokit request options to native fetch', async () => {
    const controller = new AbortController();
    let receivedSignal;
    globalThis.fetch = vi.fn(async (_url, options) => {
      receivedSignal = options.signal;
      return new Response(JSON.stringify({ id: 1 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    await createOctokit('token').rest.repos.get(withOctokitRequestSignal({
      owner: 'openchamber',
      repo: 'openchamber',
      request: { redirect: 'error' },
    }, controller.signal));

    expect(receivedSignal).toBe(controller.signal);
  });

  it('preserves caller request options when adding cancellation', () => {
    const controller = new AbortController();
    const options = withOctokitRequestSignal({
      owner: 'openchamber',
      request: { redirect: 'error' },
    }, controller.signal);

    expect(options).toMatchObject({
      owner: 'openchamber',
      request: { redirect: 'error', signal: controller.signal },
    });
  });
});
