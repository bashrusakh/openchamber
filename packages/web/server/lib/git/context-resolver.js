import fsp from 'node:fs/promises';
import path from 'node:path';

import {
  GitExecutionCancelledError,
  GitExecutionOverloadedError,
} from './execution-errors.js';

const DEFAULTS = Object.freeze({
  discoveryConcurrency: 8,
  maxPendingDiscoveries: 256,
  maxInFlightAliases: 2048,
  maxInFlightContexts: 1024,
});

const normalizeDirectory = (directory) => {
  if (typeof directory !== 'string' || !directory.trim()) {
    throw new TypeError('Git directory is required');
  }
  return path.resolve(directory.trim());
};

const defaultPathExists = async (value) => {
  try {
    await fsp.stat(value);
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      return false;
    }
    throw error;
  }
};

const normalizeCommandResult = (result) => {
  if (Buffer.isBuffer(result)) {
    return { success: true, stdout: result.toString(), stderr: '' };
  }
  if (typeof result === 'string') {
    return { success: true, stdout: result, stderr: '' };
  }
  if (result instanceof Error) {
    throw result;
  }
  if (!result || typeof result !== 'object') {
    return { success: false, stdout: '', stderr: 'Git discovery failed' };
  }
  const success = result.success === undefined
    ? result.exitCode === undefined || result.exitCode === 0
    : result.success === true;
  return {
    success,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    message: String(result.message || result.error?.message || ''),
    code: result.code || result.error?.code,
    exitCode: result.exitCode,
    reason: result.reason || result.error?.reason,
    details: result.details || result.error?.details,
  };
};

const gitErrorText = (error) => [
  error?.stderr,
  error?.stdout,
  error?.message,
  error?.error?.message,
  error,
]
  .map((value) => String(value || '').trim())
  .filter(Boolean)
  .join('\n');

const gitErrorCode = (error) => String(
  error?.code
    || error?.error?.code
    || error?.details?.code
    || error?.details?.error?.code
    || '',
).toUpperCase();

const isExecutionFailure = (error) => {
  const code = gitErrorCode(error);
  if (code === 'EACCES' || code === 'EPERM' || code === 'ENOENT') {
    return true;
  }
  return /access is denied|command not found|cannot execute|failed to spawn|no such file or directory|permission denied|spawn .*\b(?:eacces|enoent)\b/i.test(
    gitErrorText(error),
  );
};

const isConfirmedNonRepository = (error) => (
  !isExecutionFailure(error)
  && (
    error?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.error?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.details?.code === 'GIT_NOT_A_REPOSITORY'
    || error?.reason === 'not-a-repository'
    || error?.error?.reason === 'not-a-repository'
    || error?.details?.reason === 'not-a-repository'
    || /not a git repository|not inside (?:a )?work tree|this operation must be run in a work tree|outside repository/i.test(
      gitErrorText(error),
    )
  )
);

const createDiscoveryError = (result, cwd) => {
  const error = new Error(
    result?.message
      || result?.stderr
      || 'Failed to discover Git repository context',
  );
  if (result?.code !== undefined) {
    error.code = result.code;
  }
  if (result?.exitCode !== undefined) {
    error.exitCode = result.exitCode;
  }
  error.stdout = String(result?.stdout || '');
  error.stderr = String(result?.stderr || '');
  error.details = {
    operation: 'git-context-discovery',
    cwd,
    args: ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
    code: result?.code,
    exitCode: result?.exitCode,
    stdout: error.stdout,
    stderr: error.stderr,
  };
  return error;
};

const isPathWithin = (candidate, parent) => (
  candidate === parent || candidate.startsWith(`${parent}${path.sep}`)
);

const isPathIdentity = (value) => (
  typeof value === 'string'
  && value.length > 0
  && !/[\u0000\r\n]/.test(value)
  && path.isAbsolute(value)
);

const validateDiscoveryIdentity = (requestedDirectory, lines, context) => {
  if (!isPathIdentity(context.topLevel)
    || !isPathIdentity(context.gitDir)
    || !isPathIdentity(context.commonDir)) {
    return 'Git context discovery returned non-absolute repository identity';
  }

  if (!isPathWithin(requestedDirectory, context.topLevel)) {
    return 'Git context discovery returned a repository root outside the requested directory';
  }

  if (context.gitDir === context.topLevel || context.commonDir === context.topLevel) {
    return 'Git context discovery returned an invalid repository identity';
  }

  // `--git-common-dir` may be emitted relative to the discovery CWD by Git.
  // Keep accepting fully relative command output for compatibility, while
  // validating the normal absolute form as a coherent Git identity.
  const allLinesRelative = lines.every((line) => !path.isAbsolute(line));
  if (!allLinesRelative && (!path.isAbsolute(lines[0]) || !path.isAbsolute(lines[1]))) {
    return 'Git context discovery returned a non-absolute repository identity';
  }
  if (!allLinesRelative
    && !isPathWithin(context.gitDir, context.commonDir)
    && !isPathWithin(context.commonDir, context.gitDir)) {
    return 'Git context discovery returned unrelated Git and common directories';
  }

  return null;
};

const abortError = (signal) => new GitExecutionCancelledError(
  'Git context discovery was cancelled',
  { reason: signal?.reason },
);

const raceAbort = (promise, signal) => {
  if (!signal) {
    return promise;
  }
  if (signal.aborted) {
    return Promise.reject(abortError(signal));
  }
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
};

const createQueue = (concurrency, maxPending) => {
  const pending = [];
  let active = 0;

  const drain = () => {
    while (active < concurrency && pending.length > 0) {
      const entry = pending.shift();
      if (entry.cancelled) {
        continue;
      }
      active += 1;
      Promise.resolve()
        .then(entry.task)
        .then(entry.resolve, entry.reject)
        .finally(() => {
          active -= 1;
          drain();
        });
    }
  };

  const enqueue = (task, signal) => {
    if (signal?.aborted) {
      return Promise.reject(abortError(signal));
    }
    if (active >= concurrency && pending.length >= maxPending) {
      return Promise.reject(new GitExecutionOverloadedError(
        'Git discovery queue is overloaded',
        { active, pending: pending.length, maxPending },
      ));
    }

    return new Promise((resolve, reject) => {
      const entry = { task, resolve, reject, cancelled: false };
      let onAbort;
      if (signal) {
        onAbort = () => {
          if (entry.cancelled) {
            return;
          }
          entry.cancelled = true;
          const index = pending.indexOf(entry);
          if (index !== -1) {
            pending.splice(index, 1);
          }
          reject(abortError(signal));
        };
        signal.addEventListener('abort', onAbort, { once: true });
      }
      const resolveEntry = (value) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(value);
      };
      const rejectEntry = (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      entry.resolve = resolveEntry;
      entry.reject = rejectEntry;
      pending.push(entry);
      drain();
    });
  };

  return {
    enqueue,
    getStats: () => ({ active, pending: pending.length }),
  };
};

export class GitContextResolver {
  constructor(options) {
    if (!options || typeof options.runGit !== 'function') {
      throw new TypeError('runGit is required');
    }

    this.runGit = options.runGit;
    this.realpath = options.realpath || ((value) => fsp.realpath(value));
    this.pathExists = options.pathExists || defaultPathExists;
    this.discoveryConcurrency = Math.max(1, Math.floor(options.discoveryConcurrency ?? DEFAULTS.discoveryConcurrency));
    this.maxPendingDiscoveries = Math.max(0, Math.floor(options.maxPendingDiscoveries ?? DEFAULTS.maxPendingDiscoveries));
    this.maxInFlightAliases = Math.max(1, Math.floor(options.maxInFlightAliases ?? DEFAULTS.maxInFlightAliases));
    this.maxInFlightContexts = Math.max(1, Math.floor(options.maxInFlightContexts ?? DEFAULTS.maxInFlightContexts));
    this.aliases = new Map();
    this.inFlightAliases = new Map();
    this.contexts = new Map();
    this.inFlightContexts = new Set();
    this.queue = createQueue(this.discoveryConcurrency, this.maxPendingDiscoveries);
  }

  async canonicalize(value) {
    const resolved = path.resolve(value);
    try {
      const real = await this.realpath(resolved);
      return path.resolve(String(real || resolved));
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
        return resolved;
      }
      throw error;
    }
  }

  evictContexts() {
    while (this.contexts.size > this.maxInFlightContexts) {
      const oldest = this.contexts.keys().next().value;
      if (oldest === undefined) {
        return;
      }
      this.contexts.delete(oldest);
    }
  }

  rememberAlias(alias, context) {
    this.aliases.delete(alias);
    this.aliases.set(alias, context);
    while (this.aliases.size > this.maxInFlightAliases) {
      const oldest = this.aliases.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.aliases.delete(oldest);
    }
  }

  async discover(directory, requestedDirectory) {
    let result;
    try {
      result = normalizeCommandResult(await this.queue.enqueue(
        () => this.runGit(directory, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir']),
      ));
    } catch (error) {
      if (error instanceof GitExecutionCancelledError || error instanceof GitExecutionOverloadedError) {
        throw error;
      }
      if (isConfirmedNonRepository(error)) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      throw createDiscoveryError(error, directory);
    }
    if (!result.success) {
      if (isConfirmedNonRepository(result)) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      throw createDiscoveryError(result, directory);
    }

    const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length !== 3) {
      throw createDiscoveryError({
        message: 'Git context discovery returned incomplete output',
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        exitCode: result.exitCode,
      }, directory);
    }

    const canonicalizeDiscoveredPath = async (value) => {
      try {
        return await this.canonicalize(path.isAbsolute(value)
          ? value
          : path.resolve(directory, value));
      } catch (error) {
        throw createDiscoveryError(error, directory);
      }
    };
    const topLevel = await canonicalizeDiscoveredPath(lines[0]);
    const gitDir = await canonicalizeDiscoveredPath(lines[1]);
    const commonDir = await canonicalizeDiscoveredPath(lines[2]);
    const context = {
      isRepository: true,
      requestedDirectory,
      topLevel,
      gitDir,
      commonDir,
      commonId: commonDir,
      worktreeId: topLevel,
    };
    const identityError = validateDiscoveryIdentity(directory, lines, context);
    if (identityError) {
      throw createDiscoveryError({
        message: identityError,
        stdout: result.stdout,
        stderr: result.stderr,
        code: result.code,
        exitCode: result.exitCode,
      }, directory);
    }
    this.contexts.set(`${context.commonId}\0${context.worktreeId}`, context);
    this.evictContexts();
    this.rememberAlias(directory, context);
    this.rememberAlias(topLevel, context);
    return context;
  }

  resolve(directory, options = {}) {
    const requestedDirectory = normalizeDirectory(directory);
    if (options.signal?.aborted) {
      return Promise.reject(abortError(options.signal));
    }

    const resolveExistingDirectory = () => this.canonicalize(requestedDirectory).catch((error) => {
      throw createDiscoveryError(error, requestedDirectory);
    }).then((canonicalDirectory) => {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      const cached = this.aliases.get(canonicalDirectory);
      if (cached) {
        this.aliases.delete(canonicalDirectory);
        this.aliases.set(canonicalDirectory, cached);
        return cached;
      }

      const inFlight = this.inFlightAliases.get(canonicalDirectory);
      if (inFlight) {
        return raceAbort(inFlight, options.signal);
      }
      if (this.inFlightAliases.size >= this.maxInFlightAliases) {
        throw new GitExecutionOverloadedError(
          'Git context alias capacity is exhausted',
          { maxInFlightAliases: this.maxInFlightAliases },
        );
      }
      if (this.inFlightContexts.size >= this.maxInFlightContexts) {
        throw new GitExecutionOverloadedError(
          'Git context discovery capacity is exhausted',
          { maxInFlightContexts: this.maxInFlightContexts },
        );
      }

      this.inFlightContexts.add(canonicalDirectory);
      // Discovery is shared across waiters; cancellation is applied by each
      // caller's race below instead of cancelling the shared queue task.
      const discovery = this.discover(canonicalDirectory, requestedDirectory)
        .finally(() => {
          this.inFlightContexts.delete(canonicalDirectory);
          if (this.inFlightAliases.get(canonicalDirectory) === discovery) {
            this.inFlightAliases.delete(canonicalDirectory);
          }
        });
      this.inFlightAliases.set(canonicalDirectory, discovery);
      return raceAbort(discovery, options.signal);
    });

    return this.pathExists(requestedDirectory).then((exists) => {
      if (options.signal?.aborted) {
        throw abortError(options.signal);
      }
      if (!exists) {
        return { isRepository: false, requestedDirectory, reason: 'not-a-repository' };
      }
      return resolveExistingDirectory();
    });
  }

  getStats() {
    const discovery = this.queue.getStats();
    return {
      inFlightAliases: this.inFlightAliases.size,
      maxInFlightAliases: this.maxInFlightAliases,
      inFlightContexts: this.inFlightContexts.size,
      maxInFlightContexts: this.maxInFlightContexts,
      discovery: {
        ...discovery,
        concurrency: this.discoveryConcurrency,
        maxPending: this.maxPendingDiscoveries,
      },
    };
  }
}

export const createGitContextResolver = (options) => new GitContextResolver(options);
