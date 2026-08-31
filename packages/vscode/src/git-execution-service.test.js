import { beforeEach, describe, expect, it, mock } from 'bun:test';

const core = {
  checkIsGitRepository: mock(),
};

const runtime = {
  discover: mock(),
  runDirectoryFallbackRead: mock(),
};

mock.module('./gitService', () => core);
mock.module('./git-execution-runtime', () => ({ gitExecutionRuntime: runtime }));

const { createGitExecutionService } = await import('./git-execution-service');
const {
  GIT_OPERATION_PROFILE,
  getGitServiceOperationClassification,
} = await import('./git-operation-classification');

describe('VS Code Git execution service discovery fallback', () => {
  beforeEach(() => {
    core.checkIsGitRepository.mockReset();
    runtime.discover.mockReset();
    runtime.runDirectoryFallbackRead.mockReset();
    runtime.runDirectoryFallbackRead.mockImplementation((_directory, task) => task());
  });

  it('propagates permission discovery failures instead of probing raw Git', async () => {
    const failure = Object.assign(
      new Error('Git context discovery failed: EACCES permission denied'),
      { code: 'EACCES' },
    );
    runtime.discover.mockRejectedValue(failure);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .rejects.toBe(failure);
    expect(runtime.runDirectoryFallbackRead).not.toHaveBeenCalled();
    expect(core.checkIsGitRepository).not.toHaveBeenCalled();
  });

  it('keeps the raw fallback for an explicitly identified non-repository', async () => {
    runtime.discover.mockRejectedValue({ reason: 'not-a-repository' });
    core.checkIsGitRepository.mockResolvedValue(false);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .resolves.toBe(false);
    expect(runtime.runDirectoryFallbackRead).toHaveBeenCalledWith('/repo', expect.any(Function));
    expect(core.checkIsGitRepository).toHaveBeenCalledWith('/repo');
  });

  it('keeps the built-in Repository API fallback when raw discovery cannot start', async () => {
    runtime.discover.mockRejectedValue({
      code: 'ENOENT',
      details: { operation: 'git-context-discovery' },
    });
    core.checkIsGitRepository.mockResolvedValue(true);

    await expect(createGitExecutionService({ core, runtime }).checkIsGitRepository('/repo'))
      .resolves.toBe(true);
    expect(runtime.runDirectoryFallbackRead).toHaveBeenCalledWith('/repo', expect.any(Function));
    expect(core.checkIsGitRepository).toHaveBeenCalledWith('/repo');
  });

  it('classifies branch and commit checkout as worktree-scoped writes', () => {
    expect(getGitServiceOperationClassification('checkoutBranch').profile)
      .toBe(GIT_OPERATION_PROFILE.WORKTREE_WRITE);
    expect(getGitServiceOperationClassification('checkoutCommit').profile)
      .toBe(GIT_OPERATION_PROFILE.WORKTREE_WRITE);
  });
});
