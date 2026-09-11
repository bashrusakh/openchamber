import { afterEach, describe, expect, it, vi } from 'vitest';

import type { RuntimeUrlQuery, RuntimeUrlResolver } from '@openchamber/ui/lib/runtime-url';

const runtimeFetchMock = vi.fn();

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

vi.mock('@openchamber/ui/lib/runtime-fetch', () => ({
  runtimeFetch: runtimeFetchMock,
}));

const toUrl = (path: string, query?: RuntimeUrlQuery): string => {
  const params = query instanceof URLSearchParams ? query : new URLSearchParams();
  const queryString = params.toString();
  return queryString ? `${path}?${queryString}` : path;
};

const urls: RuntimeUrlResolver = {
  api: toUrl,
  authenticatedAsset: toUrl,
  auth: toUrl,
  health: (query?: RuntimeUrlQuery) => toUrl('/health', query),
  rawFile: (path: string) => toUrl('/api/fs/raw', new URLSearchParams({ path })),
  sse: toUrl,
  websocket: toUrl,
};

describe('createWebGitHubAPI list calls', () => {
  it('passes the caller signal through to runtimeFetch for prsList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    const controller = new AbortController();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, prs: [] }));

    await api.prsList('/workspace', { page: 1, query: 'bug', signal: controller.signal });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = runtimeFetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });

  it('passes the caller signal through to runtimeFetch for issuesList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    const controller = new AbortController();
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, issues: [] }));

    await api.issuesList('/workspace', { page: 1, query: 'bug', signal: controller.signal });

    expect(runtimeFetchMock).toHaveBeenCalledTimes(1);
    const [, init] = runtimeFetchMock.mock.calls[0];
    expect(init?.signal).toBe(controller.signal);
  });

  it('surfaces the server search-timeout error field from prsList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, prs: [], error: 'search timed out' }));

    const result = await api.prsList('/workspace', { page: 1, query: 'bug' });

    expect(result.error).toBe('search timed out');
  });

  it('surfaces the server search-timeout error field from issuesList', async () => {
    const { createWebGitHubAPI } = await import('./github');
    const api = createWebGitHubAPI({ urls });
    runtimeFetchMock.mockResolvedValueOnce(Response.json({ connected: true, issues: [], error: 'search timed out' }));

    const result = await api.issuesList('/workspace', { page: 1, query: 'bug' });

    expect(result.error).toBe('search timed out');
  });
});
