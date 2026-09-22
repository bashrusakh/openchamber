import { beforeEach, describe, expect, it, vi } from 'vitest';

const gitLibraries = {
  stageFiles: vi.fn(),
  unstageFiles: vi.fn(),
  isGitRepository: vi.fn(),
  getStatus: vi.fn(),
  getRangeDiff: vi.fn(),
  getRangeFiles: vi.fn(),
  getCommitDiff: vi.fn(),
  getCommitFiles: vi.fn(),
  getCommitFileDiff: vi.fn(),
  getWorktrees: vi.fn(),
  observeWorktreeTopology: vi.fn(),
  subscribeWorktreeTopologyChanges: vi.fn(),
  resolvePrimaryWorktreeRoot: vi.fn(),
  resolveWorktreeTopLevel: vi.fn(),
  getPathDiff: vi.fn(),
  getFileDiff: vi.fn(),
};

vi.mock('./index.js', () => ({
  stageFiles: gitLibraries.stageFiles,
  unstageFiles: gitLibraries.unstageFiles,
  isGitRepository: gitLibraries.isGitRepository,
  getStatus: gitLibraries.getStatus,
  getRangeDiff: gitLibraries.getRangeDiff,
  getRangeFiles: gitLibraries.getRangeFiles,
  getCommitDiff: gitLibraries.getCommitDiff,
  getCommitFiles: gitLibraries.getCommitFiles,
  getCommitFileDiff: gitLibraries.getCommitFileDiff,
  getWorktrees: gitLibraries.getWorktrees,
  observeWorktreeTopology: gitLibraries.observeWorktreeTopology,
  subscribeWorktreeTopologyChanges: gitLibraries.subscribeWorktreeTopologyChanges,
  resolvePrimaryWorktreeRoot: gitLibraries.resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel: gitLibraries.resolveWorktreeTopLevel,
  getPathDiff: gitLibraries.getPathDiff,
  getFileDiff: gitLibraries.getFileDiff,
}));

const { registerGitRoutes } = await import('./routes.js');

const createRouteRegistry = () => {
  const routes = new Map();

  return {
    app: {
      get(routePath, handler) {
        routes.set(`GET ${routePath}`, handler);
      },
      post(routePath, handler) {
        routes.set(`POST ${routePath}`, handler);
      },
      put(routePath, handler) {
        routes.set(`PUT ${routePath}`, handler);
      },
      delete(routePath, handler) {
        routes.set(`DELETE ${routePath}`, handler);
      },
    },
    getRoute(method, routePath) {
      return routes.get(`${method} ${routePath}`);
    },
  };
};

const createMockResponse = () => {
  let statusCode = 200;
  let body = null;

  return {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      body = payload;
    },
    get statusCode() {
      return statusCode;
    },
    get body() {
      return body;
    },
  };
};

describe('git routes index mutations', () => {
  beforeEach(() => {
    gitLibraries.stageFiles.mockReset();
    gitLibraries.unstageFiles.mockReset();
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getRangeDiff.mockReset();
    gitLibraries.getRangeFiles.mockReset();
    gitLibraries.getCommitDiff.mockReset();
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
    gitLibraries.resolvePrimaryWorktreeRoot.mockReset();
    gitLibraries.resolveWorktreeTopLevel.mockReset();
  });

  it('accepts legacy stage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk stage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.stageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('accepts legacy unstage path payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { path: 'a.ts' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts']);
  });

  it('accepts bulk unstage paths payloads', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/unstage')(
      { query: { directory: '/repo' }, body: { paths: ['a.ts', 'b.ts'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.unstageFiles).toHaveBeenCalledWith('/repo', ['a.ts', 'b.ts']);
  });

  it('rejects invalid path payloads before calling git', async () => {
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('POST', '/api/git/stage')(
      { query: { directory: '/repo' }, body: { paths: [' ', null] } },
      response,
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toEqual({ error: 'path parameter is required' });
    expect(gitLibraries.stageFiles).not.toHaveBeenCalled();
  });
});

describe('git diff routes', () => {
  beforeEach(() => {
    gitLibraries.getPathDiff.mockReset();
    gitLibraries.getFileDiff.mockReset();
  });

  it('admits path diffs through the execution facade with request cancellation', async () => {
    gitLibraries.getPathDiff.mockResolvedValue({ diff: 'patch', submodule: null });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/diff')(
      { query: { directory: '/repo', path: 'file.ts' } },
      response,
    );

    expect(response.body).toEqual({ diff: 'patch', submodule: null });
    expect(gitLibraries.getPathDiff).toHaveBeenCalledWith('/repo', expect.objectContaining({
      path: 'file.ts',
      signal: expect.any(AbortSignal),
    }));
  });

  it('passes request cancellation into file diffs without changing the response shape', async () => {
    gitLibraries.getFileDiff.mockResolvedValue({
      original: 'old',
      modified: 'new',
      path: 'file.ts',
      isBinary: false,
      submodule: null,
    });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/file-diff')(
      { query: { directory: '/repo', path: 'file.ts' } },
      response,
    );

    expect(response.body).toEqual({
      original: 'old',
      modified: 'new',
      path: 'file.ts',
      isBinary: false,
      submodule: null,
    });
    expect(gitLibraries.getFileDiff).toHaveBeenCalledWith('/repo', expect.objectContaining({
      path: 'file.ts',
      signal: expect.any(AbortSignal),
    }));
  });
});

describe('git collection routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getRangeDiff.mockReset();
    gitLibraries.getRangeFiles.mockReset();
    gitLibraries.getCommitDiff.mockReset();
    gitLibraries.getCommitFiles.mockReset();
    gitLibraries.getCommitFileDiff.mockReset();
    gitLibraries.observeWorktreeTopology.mockReset();
    gitLibraries.observeWorktreeTopology.mockResolvedValue(undefined);
  });

  it.each([
    ['status', '/api/git/status', { directory: '/repo' }, 'getStatus'],
    ['range', '/api/git/range-diff', { directory: '/repo', base: 'main', head: 'feature' }, 'getRangeDiff'],
    ['commit', '/api/git/commit-diff', { directory: '/repo', hash: 'a'.repeat(40) }, 'getCommitDiff'],
  ])('passes a request signal through the %s route', async (_label, routePath, query, operation) => {
    if (operation === 'getStatus') {
      gitLibraries.isGitRepository.mockResolvedValue(true);
      gitLibraries.getStatus.mockResolvedValue({ current: 'main' });
    } else if (operation === 'getRangeDiff') {
      gitLibraries.getRangeDiff.mockResolvedValue('patch');
    } else {
      gitLibraries.getCommitDiff.mockResolvedValue('patch');
    }

    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    await getRoute('GET', routePath)({ query }, createMockResponse());

    expect(gitLibraries[operation]).toHaveBeenCalledWith(
      '/repo',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('passes request cancellation through committed-file routes', async () => {
    gitLibraries.getCommitFiles.mockResolvedValue({ files: [] });
    gitLibraries.getCommitFileDiff.mockResolvedValue({ original: '', modified: '', isBinary: false });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    await getRoute('GET', '/api/git/commit-files')(
      { query: { directory: '/repo', hash: 'a'.repeat(40) } },
      createMockResponse(),
    );
    await getRoute('GET', '/api/git/commit-file-diff')(
      { query: { directory: '/repo', hash: 'a'.repeat(40), path: 'file.ts' } },
      createMockResponse(),
    );

    expect(gitLibraries.getCommitFiles).toHaveBeenCalledWith('/repo', 'a'.repeat(40), {
      signal: expect.any(AbortSignal),
    });
    expect(gitLibraries.getCommitFileDiff).toHaveBeenCalledWith(
      '/repo',
      'a'.repeat(40),
      'file.ts',
      false,
      { signal: expect.any(AbortSignal) },
    );
  });

  it('passes cancellation through range file collection too', async () => {
    gitLibraries.getRangeFiles.mockResolvedValue([]);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    await getRoute('GET', '/api/git/range-files')(
      { query: { directory: '/repo', base: 'main', head: 'feature' } },
      createMockResponse(),
    );

    expect(gitLibraries.getRangeFiles).toHaveBeenCalledWith('/repo', expect.objectContaining({
      signal: expect.any(AbortSignal),
    }));
  });
});

describe('git worktree topology routes', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.getWorktrees.mockReset();
    gitLibraries.observeWorktreeTopology.mockReset();
    gitLibraries.subscribeWorktreeTopologyChanges.mockReset();
    gitLibraries.observeWorktreeTopology.mockResolvedValue(undefined);
  });

  it('observes the repository topology while serving status, never for non-repositories', async () => {
    gitLibraries.isGitRepository.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main' });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/status');

    const repoResponse = createMockResponse();
    await route({ query: { directory: '/repo' } }, repoResponse);
    expect(repoResponse.body).toEqual({ current: 'main' });
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);
  });

  it('observes topology after a repository listing and reports listing failures', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    gitLibraries.getWorktrees
      .mockResolvedValueOnce([{ path: '/repo', branch: 'main' }])
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error('git failed'));
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const route = getRoute('GET', '/api/git/worktrees');

    const listed = createMockResponse();
    await route({ query: { directory: '/repo' } }, listed);
    expect(listed.body).toEqual([{ path: '/repo', branch: 'main' }]);
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledWith('/repo');

    await route({ query: { directory: '/plain-folder' } }, createMockResponse());
    expect(gitLibraries.observeWorktreeTopology).toHaveBeenCalledTimes(1);

    const failed = createMockResponse();
    await route({ query: { directory: '/repo' } }, failed);
    expect(failed.statusCode).toBe(500);
    expect(failed.body).toEqual({ error: 'git failed' });
    errorSpy.mockRestore();
  });

  it('forwards topology changes to the control event emitter once', async () => {
    let listener = null;
    gitLibraries.subscribeWorktreeTopologyChanges.mockImplementation((next) => {
      listener = next;
      return () => undefined;
    });
    gitLibraries.getWorktrees.mockResolvedValue([]);
    const emitWorktreeChanged = vi.fn();
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app, { emitWorktreeChanged });
    const route = getRoute('GET', '/api/git/worktrees');

    await route({ query: { directory: '/repo' } }, createMockResponse());
    await route({ query: { directory: '/repo' } }, createMockResponse());
    expect(gitLibraries.subscribeWorktreeTopologyChanges).toHaveBeenCalledTimes(1);

    listener({ directories: ['/repo'], at: 123 });
    expect(emitWorktreeChanged).toHaveBeenCalledWith({ directories: ['/repo'], at: 123 });
  });
});

describe('git routes status discovery', () => {
  beforeEach(() => {
    gitLibraries.isGitRepository.mockReset();
    gitLibraries.getStatus.mockReset();
    gitLibraries.resolvePrimaryWorktreeRoot.mockReset();
    gitLibraries.resolveWorktreeTopLevel.mockReset();
  });

  it('returns a soft non-repo payload for non-git folders', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(false);
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/tmp/not-a-repo' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });
    expect(gitLibraries.getStatus).not.toHaveBeenCalled();
  });

  it('does not abort when getStatus throws a non-repo GitError', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockRejectedValue(
      Object.assign(new Error('fatal: not a git repository (or any of the parent directories): .git'), {
        code: 'GIT_NOT_A_REPOSITORY',
        reason: 'not-a-repository',
        task: { commands: ['status'] },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: '/opened/project' } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toMatchObject({ isGitRepository: false });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/project', {
      mode: undefined,
      signal: expect.any(AbortSignal),
    });
  });

  it('does not soften a permission error that mentions a non-repository', async () => {
    gitLibraries.isGitRepository.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied while checking (not a git repository)'), {
        code: 'EACCES',
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/check')(
      { query: { directory: '/protected-repo' } },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to check git repository' });
  });

  it('does not soften a missing Git executable as a deleted directory', async () => {
    gitLibraries.isGitRepository.mockRejectedValue(
      Object.assign(new Error('Git context discovery failed'), {
        code: 'ENOENT',
        details: { operation: 'git-context-discovery' },
      }),
    );
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/check')(
      { query: { directory: '/repo' } },
      response,
    );

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Failed to check git repository' });
  });

  it('keeps deleted-directory soft behavior for check, status, and root routes', async () => {
    const directory = '/deleted-worktree';
    gitLibraries.isGitRepository.mockResolvedValue(false);
    gitLibraries.resolvePrimaryWorktreeRoot.mockResolvedValue({ root: directory });
    gitLibraries.resolveWorktreeTopLevel.mockResolvedValue({ root: directory });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);

    const checkResponse = createMockResponse();
    await getRoute('GET', '/api/git/check')({ query: { directory } }, checkResponse);
    expect(checkResponse.statusCode).toBe(200);
    expect(checkResponse.body).toEqual({ isGitRepository: false });

    const statusResponse = createMockResponse();
    await getRoute('GET', '/api/git/status')({ query: { directory } }, statusResponse);
    expect(statusResponse.statusCode).toBe(200);
    expect(statusResponse.body).toEqual({
      isGitRepository: false,
      files: [],
      branch: null,
      ahead: 0,
      behind: 0,
    });

    const primaryResponse = createMockResponse();
    await getRoute('GET', '/api/git/primary-root')({ query: { directory } }, primaryResponse);
    expect(primaryResponse.statusCode).toBe(200);
    expect(primaryResponse.body).toEqual({ root: directory });

    const topLevelResponse = createMockResponse();
    await getRoute('GET', '/api/git/toplevel')({ query: { directory } }, topLevelResponse);
    expect(topLevelResponse.statusCode).toBe(200);
    expect(topLevelResponse.body).toEqual({ root: directory });
  });

  it('uses the opened project path from query arrays without falling back to cwd', async () => {
    gitLibraries.isGitRepository.mockResolvedValue(true);
    gitLibraries.getStatus.mockResolvedValue({ current: 'main', files: [], isClean: true, ahead: 0, behind: 0 });
    const { app, getRoute } = createRouteRegistry();
    registerGitRoutes(app);
    const response = createMockResponse();

    await getRoute('GET', '/api/git/status')(
      { query: { directory: ['/opened/git-project', '/ignored'] } },
      response,
    );

    expect(response.statusCode).toBe(200);
    expect(gitLibraries.isGitRepository).toHaveBeenCalledWith('/opened/git-project', {
      signal: expect.any(AbortSignal),
    });
    expect(gitLibraries.getStatus).toHaveBeenCalledWith('/opened/git-project', {
      mode: undefined,
      signal: expect.any(AbortSignal),
    });
    expect(response.body).toMatchObject({ current: 'main' });
  });
});
