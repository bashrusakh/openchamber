import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const searchMock = vi.fn();
const listForRepoMock = vi.fn();
const pullsListMock = vi.fn();

vi.mock('./index.js', () => ({
  getOctokitOrNull: () => ({
    rest: {
      search: { issuesAndPullRequests: searchMock },
      issues: { listForRepo: listForRepoMock },
      pulls: { list: pullsListMock },
    },
  }),
  resolveGitHubRepoFromDirectory: async () => ({
    repo: { owner: 'acme', repo: 'app', url: 'https://github.com/acme/app' },
  }),
}));

vi.mock('./repo/fork-detection.js', () => ({
  resolveRepoNetwork: async () => null,
}));

const { registerGitHubRoutes } = await import('./routes.js');

const createApp = () => {
  const app = express();
  registerGitHubRoutes(app);
  return app;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitHub search routes timeout surfacing', () => {
  it('returns a distinguishable search-timed-out error for issues search', async () => {
    const app = createApp();
    const timeoutError = new Error('The operation was aborted due to timeout');
    timeoutError.name = 'TimeoutError';
    searchMock.mockRejectedValueOnce(timeoutError);

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(response.body).toMatchObject({
      connected: true,
      issues: [],
      hasMore: false,
      error: 'search timed out',
    });
  });

  it('returns a distinguishable search-timed-out error for PRs search', async () => {
    const app = createApp();
    const abortError = new Error('This operation was aborted');
    abortError.name = 'AbortError';
    searchMock.mockRejectedValueOnce(abortError);

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(response.body).toMatchObject({
      connected: true,
      prs: [],
      hasMore: false,
      error: 'search timed out',
    });
  });

  it('does not mark non-timeout search failures as timed out', async () => {
    const app = createApp();
    searchMock.mockRejectedValueOnce(new Error('rate limited'));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(response.body.error).toBeUndefined();
    expect(response.body.issues).toEqual([]);
  });
});
