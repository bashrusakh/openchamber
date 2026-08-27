export const LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
export const LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES = 64 * 1024;
export const LOGIN_SHELL_ENV_MAX_ENTRY_BYTES = 8 * 1024;
export const LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES = 32 * 1024;
export const LOGIN_SHELL_ENV_TIMEOUT_MS = 5_000;
export const LOGIN_SHELL_ENV_START_MARKER = '__OPENCHAMBER_LOGIN_ENV_START__';
export const LOGIN_SHELL_ENV_END_MARKER = '__OPENCHAMBER_LOGIN_ENV_END__';
export const LOGIN_SHELL_ENV_COMMAND = `printf '\\000${LOGIN_SHELL_ENV_START_MARKER}\\000'; command env -0 && printf '${LOGIN_SHELL_ENV_END_MARKER}\\000'`;

const LOGIN_SHELL_ENV_MAX_ENTRIES = 256;
// Match conventional environment names, dot-containing tooling keys, and Windows values such as ProgramFiles(x86).
const ENVIRONMENT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.()]*$/;

const parseEnvironmentEntry = (entry, maxPathEntryBytes) => {
  const separatorIndex = entry.indexOf('=');
  if (separatorIndex <= 0) {
    return null;
  }

  const key = entry.slice(0, separatorIndex);
  if (!ENVIRONMENT_KEY_PATTERN.test(key)) {
    return null;
  }

  const entryBytes = Buffer.byteLength(entry);
  const entryLimit = key.toLowerCase() === 'path'
    ? maxPathEntryBytes
    : LOGIN_SHELL_ENV_MAX_ENTRY_BYTES;
  if (entryBytes > entryLimit) {
    return null;
  }

  return {
    entryBytes,
    key,
    value: entry.slice(separatorIndex + 1),
  };
};

const normalizeUtf8Output = (raw, maxBytes) => {
  const output = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw ?? '');
  if (!output || Buffer.byteLength(output) > maxBytes) {
    return null;
  }
  return output;
};

const normalizeRawCapture = (raw) => normalizeUtf8Output(raw, LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES);

const resolveBoundedLimit = (value, fallback, maximum) => {
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), maximum);
};

export function parseBoundedNullSeparatedEnvSnapshot(raw, options = {}) {
  const maxInputBytes = resolveBoundedLimit(
    options.maxInputBytes,
    LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES,
    LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES
  );
  const maxPathEntryBytes = resolveBoundedLimit(
    options.maxPathEntryBytes,
    LOGIN_SHELL_ENV_MAX_ENTRY_BYTES,
    LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES
  );
  const output = normalizeUtf8Output(raw, maxInputBytes);
  if (!output || !output.endsWith('\0')) {
    return null;
  }

  const entries = output.split('\0');
  const prioritizePath = maxPathEntryBytes > LOGIN_SHELL_ENV_MAX_ENTRY_BYTES;
  let prioritizedPath = null;
  if (prioritizePath) {
    entries.forEach((entry, index) => {
      if (!entry) {
        return;
      }
      const parsed = parseEnvironmentEntry(entry, maxPathEntryBytes);
      if (parsed?.key.toLowerCase() === 'path') {
        prioritizedPath = { ...parsed, index };
      }
    });
  }

  const result = Object.create(null);
  const retainedEntries = [];
  const maxNonCriticalEntries = LOGIN_SHELL_ENV_MAX_ENTRIES - (prioritizedPath ? 1 : 0);
  const maxNonCriticalBytes = LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES - (
    prioritizedPath ? prioritizedPath.entryBytes + 1 : 0
  );
  let retainedBytes = 0;
  entries.forEach((entry, index) => {
    if (!entry || prioritizedPath?.index === index) {
      return;
    }

    const parsed = parseEnvironmentEntry(entry, maxPathEntryBytes);
    if (!parsed) {
      return;
    }

    const entryCost = parsed.entryBytes + 1;
    if (
      retainedEntries.length >= maxNonCriticalEntries ||
      retainedBytes + entryCost > maxNonCriticalBytes
    ) {
      return;
    }

    retainedEntries.push({ ...parsed, index });
    retainedBytes += entryCost;
  });

  if (prioritizedPath) {
    retainedEntries.push(prioritizedPath);
  }

  retainedEntries.sort((left, right) => left.index - right.index);
  for (const entry of retainedEntries) {
    result[entry.key] = entry.value;
  }

  return retainedEntries.length > 0 ? result : null;
}

function parseLoginShellEnvSnapshot(raw) {
  const output = normalizeRawCapture(raw);
  if (!output) {
    return null;
  }

  const startToken = `\0${LOGIN_SHELL_ENV_START_MARKER}\0`;
  const endToken = `${LOGIN_SHELL_ENV_END_MARKER}\0`;
  const endIndex = output.lastIndexOf(endToken);
  const startIndex = endIndex === -1 ? -1 : output.lastIndexOf(startToken, endIndex);
  if (startIndex === -1 || endIndex < startIndex + startToken.length) {
    return null;
  }

  return parseBoundedNullSeparatedEnvSnapshot(
    output.slice(startIndex + startToken.length, endIndex),
    { maxPathEntryBytes: LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES }
  );
}

export function captureLoginShellEnvSnapshot(shellPath, runSpawnSync) {
  if (!shellPath || !runSpawnSync) {
    return null;
  }

  try {
    const result = runSpawnSync(shellPath, ['-l', '-c', LOGIN_SHELL_ENV_COMMAND], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
      timeout: LOGIN_SHELL_ENV_TIMEOUT_MS,
      windowsHide: true,
    });
    if (!result || result.error || result.status !== 0) {
      return null;
    }
    return parseLoginShellEnvSnapshot(result.stdout);
  } catch {
    return null;
  }
}

export const getLoginShellEnvCandidates = (configuredShell) => (
  [configuredShell, '/bin/zsh', '/bin/bash', '/bin/sh'].filter(Boolean)
);

export function captureLoginShellEnvSnapshotFromCandidates(shellCandidates, runSpawnSync) {
  for (const shellPath of shellCandidates) {
    const shellName = String(shellPath).split(/[\\/]/).pop().toLowerCase();
    if (shellName === 'nu' || shellName === 'nu.exe') {
      continue;
    }

    const snapshot = captureLoginShellEnvSnapshot(shellPath, runSpawnSync);
    if (snapshot) {
      return snapshot;
    }
  }

  return null;
}
