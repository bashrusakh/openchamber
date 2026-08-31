import * as rawGit from './service.js';
import {
  createGitContextResolver,
} from './context-resolver.js';
import {
  createGitExecutionCoordinator,
  GIT_READ_ONLY_ENV,
  GIT_OPERATION_KIND,
} from './execution-coordinator.js';
import {
  runWithGitExecutionScope,
} from './execution-scope.js';

const operation = Object.freeze({
  read: GIT_OPERATION_KIND.READ,
  worktreeWrite: GIT_OPERATION_KIND.WORKTREE_WRITE,
  commonWrite: GIT_OPERATION_KIND.COMMON_WRITE,
  topologyWrite: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
});

const operationKinds = Object.freeze({
  isGitRepository: operation.read,
  getStatus: operation.read,
  getGlobalIdentity: operation.read,
  getRemoteUrl: operation.read,
  getCurrentIdentity: operation.read,
  hasLocalIdentity: operation.read,
  getDiff: operation.read,
  listUntrackedPaths: operation.read,
  getUntrackedDiffs: operation.read,
  getRangeDiff: operation.read,
  getBranchBase: operation.read,
  getRangeFiles: operation.read,
  getFileDiff: operation.read,
  listStashes: operation.read,
  countStashFiles: operation.read,
  getBranches: operation.read,
  getWorktrees: operation.read,
  previewWorktreeCreate: operation.read,
  getLog: operation.read,
  getCommitFiles: operation.read,
  getCommitFileDiff: operation.read,
  getRemotes: operation.read,
  isLinkedWorktree: operation.read,
  validateWorktreeDirectory: operation.read,
  canonicalizeWorktreeState: operation.read,
  getConflictDetails: operation.read,
  getIntegrateConflictDetails: operation.read,
  getRepositoryRoot: operation.read,
  resolvePrimaryWorktreeRoot: operation.read,
  resolveWorktreeTopLevel: operation.read,
  getCommitSummaries: operation.read,
  isCherryPickInProgress: operation.read,
  collectDiffs: operation.read,
  revertFile: operation.worktreeWrite,
  stageFile: operation.worktreeWrite,
  stageFiles: operation.worktreeWrite,
  unstageFile: operation.worktreeWrite,
  unstageFiles: operation.worktreeWrite,
  applyHunk: operation.worktreeWrite,
  checkoutCommit: operation.worktreeWrite,
  cherryPick: operation.commonWrite,
  revertCommit: operation.worktreeWrite,
  resetToCommit: operation.commonWrite,
  checkoutBranch: operation.worktreeWrite,
  createBranch: operation.commonWrite,
  deleteBranch: operation.commonWrite,
  renameBranch: operation.commonWrite,
  deleteRemoteBranch: operation.commonWrite,
  setLocalIdentity: operation.commonWrite,
  removeRemote: operation.commonWrite,
  stashPush: operation.commonWrite,
  stashApply: operation.commonWrite,
  stashDrop: operation.commonWrite,
  stashPop: operation.commonWrite,
  commit: operation.commonWrite,
  push: operation.commonWrite,
  pull: operation.commonWrite,
  fetch: operation.commonWrite,
  rebase: operation.commonWrite,
  abortRebase: operation.commonWrite,
  continueRebase: operation.commonWrite,
  merge: operation.commonWrite,
  abortMerge: operation.commonWrite,
  continueMerge: operation.commonWrite,
  computeIntegratePlan: operation.commonWrite,
  abortIntegrate: operation.commonWrite,
  continueIntegrate: operation.commonWrite,
  integrateWorktreeCommits: operation.topologyWrite,
  validateWorktreeCreate: operation.commonWrite,
  createWorktree: operation.topologyWrite,
  removeWorktree: operation.topologyWrite,
  ensureWorktreeLongpaths: operation.worktreeWrite,
  populateWorktreeWithLockRecovery: operation.worktreeWrite,
});

const networkOperations = new Set(['push', 'pull', 'fetch', 'deleteRemoteBranch']);
const repositoryInputOperations = new Set([
  'computeIntegratePlan',
  'integrateWorktreeCommits',
  'abortIntegrate',
  'continueIntegrate',
]);

const operationDirectory = (name, args) => (
  repositoryInputOperations.has(name) ? args[0]?.repoRoot : args[0]
);

const errorText = (error) => [
  error?.message,
  error?.stderr,
  error?.stdout,
  error,
].map((value) => String(value || '').trim()).filter(Boolean).join('\n');

const createDiscoveryRunner = (gitModule = rawGit) => async (cwd, args) => {
  try {
    const git = await gitModule.createGit(cwd, { envOverrides: GIT_READ_ONLY_ENV });
    return { success: true, stdout: await git.raw(args), stderr: '' };
  } catch (error) {
    return {
      success: false,
      code: typeof error?.code === 'string' ? error.code : undefined,
      exitCode: typeof error?.code === 'number' ? error.code : undefined,
      stdout: String(error?.stdout || ''),
      stderr: String(error?.stderr || ''),
      message: errorText(error),
    };
  }
};

const worktreeMayUseNetwork = (input) => Boolean(
  input?.setUpstream
  || (input?.ensureRemoteName && input?.ensureRemoteUrl)
  || String(input?.existingBranch || input?.startRef || '').includes('/'),
);

export const createGitExecutionService = (dependencies = {}) => {
  const raw = dependencies.raw || rawGit;
  const coordinator = dependencies.coordinator || createGitExecutionCoordinator();
  const resolver = dependencies.resolver || createGitContextResolver({
    runGit: dependencies.runGit || createDiscoveryRunner(raw),
  });

  const createBackgroundScheduler = (lease, outerContext) => async (request, task) => {
    const context = request.operation === 'worktreeAttachment'
      ? outerContext
      : await resolver.resolve(request.contextDirectory);
    return coordinator.run({
      context,
      kind: GIT_OPERATION_KIND.TOPOLOGY_WRITE,
      targetWorktree: true,
      network: request.network,
      label: request.operation,
      lease: request.operation === 'worktreeAttachment' ? lease : undefined,
    }, () => runWithGitExecutionScope(false, task));
  };

  const runOperation = async (name, directory, args, options = {}) => {
    const kind = operationKinds[name];
    if (!kind) {
      throw new TypeError(`Unclassified Git service operation: ${name}`);
    }
    const context = await resolver.resolve(directory, { signal: options.signal });
    if (!context.isRepository) {
      return runWithGitExecutionScope(kind === GIT_OPERATION_KIND.READ, () => raw[name](...args));
    }
    return coordinator.run({
      context,
      kind,
      targetWorktree: options.targetWorktree ?? kind !== GIT_OPERATION_KIND.COMMON_WRITE,
      network: options.network ?? networkOperations.has(name),
      label: name,
      signal: options.signal,
      queueTimeoutMs: options.queueTimeoutMs,
    }, (lease) => runWithGitExecutionScope(
      kind === GIT_OPERATION_KIND.READ,
      () => raw[name](
        ...args,
        ...(name === 'createWorktree'
          ? [{ scheduleBackground: createBackgroundScheduler(lease, context) }]
          : []),
      ),
    ));
  };

  const runStatus = async (directory, options) => {
    const context = await resolver.resolve(directory, { signal: options?.signal });
    if (!context.isRepository) {
      return runWithGitExecutionScope(true, () => raw.getStatus(directory, options));
    }
    const shape = options?.mode === 'light' ? 'light' : 'full';
    return coordinator.runStatus({
      context,
      shape,
      signal: options?.signal,
      label: `status:${shape}`,
    }, (sourceShape) => runWithGitExecutionScope(true, () => raw.getStatus(
      directory,
      sourceShape === 'light' ? { mode: 'light' } : undefined,
    )));
  };

  const checkIsGitRepository = async (directory) => (
    (await resolver.resolve(directory)).isRepository
  );

  const wrapped = {};
  for (const name of Object.keys(operationKinds)) {
    if (name === 'isGitRepository' || name === 'getStatus') {
      continue;
    }
    wrapped[name] = (...args) => runOperation(name, operationDirectory(name, args), args, {
      network: name === 'validateWorktreeCreate' || name === 'createWorktree'
        ? worktreeMayUseNetwork(args[1])
        : undefined,
    });
  }

  wrapped.isGitRepository = checkIsGitRepository;
  wrapped.getStatus = runStatus;
  wrapped.getGlobalIdentity = (...args) => coordinator.run({
    context: {
      isRepository: true,
      commonId: 'openchamber:git-global-config',
      worktreeId: 'openchamber:git-global-config',
    },
    kind: GIT_OPERATION_KIND.READ,
    targetWorktree: false,
    label: 'getGlobalIdentity',
  }, () => runWithGitExecutionScope(true, () => raw.getGlobalIdentity(...args)));
  wrapped.getWorktreeBootstrapStatus = (...args) => raw.getWorktreeBootstrapStatus(...args);
  wrapped.getRepositoryRoot = (...args) => runOperation('getRepositoryRoot', args[0], args);
  wrapped.getIntegrateConflictDetails = (...args) => runOperation(
    'getIntegrateConflictDetails',
    args[0],
    args,
  );
  wrapped.getRemoteUrl = (...args) => runOperation('getRemoteUrl', args[0], args);
  wrapped.getCurrentIdentity = (...args) => runOperation('getCurrentIdentity', args[0], args);
  wrapped.hasLocalIdentity = (...args) => runOperation('hasLocalIdentity', args[0], args);

  return Object.freeze({ ...raw, ...wrapped, coordinator, resolver });
};

const defaultService = createGitExecutionService();

export const {
  isGitRepository,
  getStatus,
  getGlobalIdentity,
  getRemoteUrl,
  getCurrentIdentity,
  hasLocalIdentity,
  getDiff,
  listUntrackedPaths,
  getUntrackedDiffs,
  getRangeDiff,
  getBranchBase,
  getRangeFiles,
  getFileDiff,
  listStashes,
  countStashFiles,
  stashPush,
  stashApply,
  stashDrop,
  stashPop,
  getBranches,
  getWorktrees,
  validateWorktreeCreate,
  previewWorktreeCreate,
  createWorktree,
  getWorktreeBootstrapStatus,
  removeWorktree,
  getLog,
  getCommitFiles,
  getCommitFileDiff,
  getRemotes,
  removeRemote,
  isLinkedWorktree,
  validateWorktreeDirectory,
  canonicalizeWorktreeState,
  getConflictDetails,
  getIntegrateConflictDetails,
  getRepositoryRoot,
  revertFile,
  stageFile,
  stageFiles,
  unstageFile,
  unstageFiles,
  applyHunk,
  checkoutCommit,
  cherryPick,
  revertCommit,
  resetToCommit,
  checkoutBranch,
  createBranch,
  deleteBranch,
  renameBranch,
  deleteRemoteBranch,
  setLocalIdentity,
  commit,
  push,
  pull,
  fetch,
  rebase,
  abortRebase,
  continueRebase,
  merge,
  abortMerge,
  continueMerge,
  computeIntegratePlan,
  abortIntegrate,
  continueIntegrate,
  integrateWorktreeCommits,
  resolvePrimaryWorktreeRoot,
  resolveWorktreeTopLevel,
  getCommitSummaries,
  isCherryPickInProgress,
  collectDiffs,
  ensureWorktreeLongpaths,
  populateWorktreeWithLockRecovery,
  coordinator,
  resolver,
} = defaultService;

export { defaultService as gitExecutionService };
