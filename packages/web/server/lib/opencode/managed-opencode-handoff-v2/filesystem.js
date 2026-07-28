import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_ROOT = path.join(
  os.homedir(),
  '.local',
  'state',
  'openchamber',
  'managed-opencode-handoff-v2',
);

const currentUid = () => (typeof process.getuid === 'function' ? process.getuid() : null);

const assertOwner = (stat, label) => {
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`Managed OpenCode handoff v2 ${label} is not owned by this user`);
  }
};

const assertMode = (stat, expectedMode, label) => {
  if ((stat.mode & 0o777) !== expectedMode) {
    throw new Error(`Managed OpenCode handoff v2 ${label} has unsafe permissions`);
  }
};

export const resolveManagedOpenCodeHandoffV2Root = (rootDir) => {
  const candidate = rootDir === undefined ? MANAGED_OPENCODE_HANDOFF_V2_DEFAULT_ROOT : rootDir;
  if (typeof candidate !== 'string' || candidate.trim().length === 0 || !path.isAbsolute(candidate)) {
    throw new TypeError('Managed OpenCode handoff v2 root must be an absolute path');
  }

  const resolved = path.resolve(candidate);
  if (resolved === path.parse(resolved).root) {
    throw new TypeError('Managed OpenCode handoff v2 root must not be a filesystem root');
  }
  return resolved;
};

const assertPrivateDirectory = (directoryPath) => {
  const stat = fs.lstatSync(directoryPath);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error('Managed OpenCode handoff v2 root must be a regular directory');
  }
  assertOwner(stat, 'root');
  assertMode(stat, 0o700, 'root');
  return stat;
};

export const ensurePrivateDirectory = (directoryPath, { platform = process.platform } = {}) => {
  if (platform === 'win32') {
    throw new Error('Managed OpenCode handoff v2 currently requires a POSIX filesystem');
  }

  const resolved = resolveManagedOpenCodeHandoffV2Root(directoryPath);
  try {
    assertPrivateDirectory(resolved);
    return resolved;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  fs.mkdirSync(path.dirname(resolved), { recursive: true, mode: 0o700 });
  let created = false;
  try {
    fs.mkdirSync(resolved, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }

  if (created) fs.chmodSync(resolved, 0o700);
  assertPrivateDirectory(resolved);
  return resolved;
};

export const assertPrivateRegularFile = (filePath, expectedMode = 0o600) => {
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error('Managed OpenCode handoff v2 file must be regular');
  }
  assertOwner(stat, 'file');
  assertMode(stat, expectedMode, 'file');
  return stat;
};

/**
 * POSIX durability is a security boundary for v2 initialization. A filesystem
 * that cannot fsync the containing directory is unsupported rather than a
 * best-effort success.
 */
export const fsyncDirectory = (directoryPath) => {
  let descriptor;
  try {
    descriptor = fs.openSync(
      directoryPath,
      fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0),
    );
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
};
