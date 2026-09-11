import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { Octokit } from '@octokit/rest';

// A real Octokit whose transport is stubbed. This routes the thrown fetch
// errors through @octokit/request's real fetch-wrapper, so the tests exercise
// the exact wrapped shape production sees (a TimeoutError from
// AbortSignal.timeout becomes an "HttpError" RequestError with `cause` set to
// the original error).
const requestFetchMock = vi.fn();
const octokit = new Octokit({
  auth: 'test-token',
  request: { fetch: requestFetchMock },
});

vi.mock('./index.js', () => ({
  getOctokitOrNull: () => octokit,
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

const namedError = (name, message) => {
  const error = new Error(message);
  error.name = name;
  return error;
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('GitHub search routes timeout surfacing', () => {
  it('returns a distinguishable search-timed-out error for issues search', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(namedError('TimeoutError', 'The operation was aborted due to timeout'));

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
    requestFetchMock.mockRejectedValueOnce(namedError('TimeoutError', 'The operation was aborted due to timeout'));

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

  it('does not mark non-timeout search failures as timed out on the issues route', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(new Error('rate limited'));

    const response = await request(app)
      .get('/api/github/issues/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(200);

    expect(response.body.error).toBeUndefined();
    expect(response.body.issues).toEqual([]);
  });

  it('rethrows a non-timeout search failure on the PRs route as a 500', async () => {
    const app = createApp();
    requestFetchMock.mockRejectedValueOnce(new Error('rate limited'));

    const response = await request(app)
      .get('/api/github/pulls/list')
      .query({ directory: '/workspace', page: '1', query: 'bug' })
      .expect(500);

    expect(response.body.error).toBe('rate limited');
  });
});
