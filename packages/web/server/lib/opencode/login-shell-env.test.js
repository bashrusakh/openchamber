import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import {
  captureLoginShellEnvSnapshot,
  LOGIN_SHELL_ENV_COMMAND,
  LOGIN_SHELL_ENV_END_MARKER,
  LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
  LOGIN_SHELL_ENV_MAX_ENTRY_BYTES,
  LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES,
  LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES,
  LOGIN_SHELL_ENV_START_MARKER,
  LOGIN_SHELL_ENV_TIMEOUT_MS,
  captureLoginShellEnvSnapshotFromCandidates,
  getLoginShellEnvCandidates,
  parseBoundedNullSeparatedEnvSnapshot,
} from './login-shell-env.js';

const itIf = (condition) => condition ? it : it.skip;
const frameLoginShellEnv = (records) => (
  `\0${LOGIN_SHELL_ENV_START_MARKER}\0${records}${LOGIN_SHELL_ENV_END_MARKER}\0`
);

describe('login shell environment snapshots', () => {
  it('captures valid login tooling values without starting an interactive shell', () => {
    const calls = [];
    const snapshot = captureLoginShellEnvSnapshot('/bin/sh', (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: frameLoginShellEnv('PATH=/login/bin\0TOOL_HOME=/tools\0') };
    });

    expect(snapshot).toMatchObject({
      PATH: '/login/bin',
      TOOL_HOME: '/tools',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('/bin/sh');
    expect(calls[0].args).toEqual(['-l', '-c', LOGIN_SHELL_ENV_COMMAND]);
    expect(calls[0].args).not.toContain('-i');
    expect(calls[0].args[2]).toContain('command env -0');
    expect(calls[0].options).toMatchObject({
      maxBuffer: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
      timeout: LOGIN_SHELL_ENV_TIMEOUT_MS,
      encoding: 'utf8',
      windowsHide: true,
    });
    expect(calls[0].options.stdio).toEqual(['ignore', 'pipe', 'ignore']);
  });

  itIf(process.platform === 'linux')('does not invoke interactive startup hooks during capture', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'openchamber-login-shell-env-'));
    const shellPath = path.join(directory, 'login-shell');
    const markerPath = path.join(directory, 'interactive-hook-ran');
    const previousMarkerPath = process.env.INTERACTIVE_HOOK_MARKER;
    fs.writeFileSync(shellPath, [
      '#!/bin/sh',
      'for argument in "$@"; do',
      '  case "$argument" in -*i*) : > "$INTERACTIVE_HOOK_MARKER" ;; esac',
      'done',
      '[ -t 0 ] && : > "$INTERACTIVE_HOOK_MARKER"',
      `printf '\\000${LOGIN_SHELL_ENV_START_MARKER}\\000PATH=/login/bin\\000TOOL_HOME=/tools\\000${LOGIN_SHELL_ENV_END_MARKER}\\000'`,
    ].join('\n'));
    fs.chmodSync(shellPath, 0o755);
    process.env.INTERACTIVE_HOOK_MARKER = markerPath;

    try {
      const snapshot = captureLoginShellEnvSnapshot(shellPath, spawnSync);

      expect(snapshot).toMatchObject({
        PATH: '/login/bin',
        TOOL_HOME: '/tools',
      });
      expect(fs.existsSync(markerPath)).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
      if (previousMarkerPath === undefined) delete process.env.INTERACTIVE_HOOK_MARKER;
      else process.env.INTERACTIVE_HOOK_MARKER = previousMarkerPath;
    }
  });

  it('retains a framed POSIX PATH larger than the generic entry limit', () => {
    const pathValue = '/login/bin:'.padEnd(
      16 * 1024 - 'PATH='.length,
      'x'
    );
    const snapshot = captureLoginShellEnvSnapshot('/bin/sh', () => ({
      status: 0,
      stdout: frameLoginShellEnv(`PATH=${pathValue}\0TOOL_HOME=/tools\0`),
    }));

    expect(Buffer.byteLength(`PATH=${pathValue}`)).toBeGreaterThan(LOGIN_SHELL_ENV_MAX_ENTRY_BYTES);
    expect(snapshot?.PATH).toBe(pathValue);
    expect(snapshot?.TOOL_HOME).toBe('/tools');
  });

  it('drops malformed and oversized records while retaining bounded valid values', () => {
    const oversizedValue = 'x'.repeat(LOGIN_SHELL_ENV_MAX_ENTRY_BYTES);
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(
      `PATH=/login/bin\0DOT.KEY=/tools\0MALFORMED-KEY=unsafe\0CONTROL\u0001KEY=unsafe\0HUGE=${oversizedValue}\0TOOL_HOME=/tools\0`
    );

    expect(snapshot).toMatchObject({
      PATH: '/login/bin',
      'DOT.KEY': '/tools',
      TOOL_HOME: '/tools',
    });
    expect(snapshot?.['MALFORMED-KEY']).toBeUndefined();
    expect(snapshot?.['CONTROL\u0001KEY']).toBeUndefined();
    expect(snapshot?.HUGE).toBeUndefined();
    expect(parseBoundedNullSeparatedEnvSnapshot('PATH=/login/bin')).toBeNull();
  });

  it('returns the deterministic valid prefix when the entry count exceeds the cap', () => {
    const records = Array.from(
      { length: 257 },
      (_, index) => `TOOL_${index}=value-${index}`
    ).join('\0');
    const output = `${records}\0`;
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(output);

    expect(Object.keys(snapshot ?? {})).toHaveLength(256);
    expect(snapshot).toMatchObject({
      TOOL_0: 'value-0',
      TOOL_255: 'value-255',
    });
    expect(snapshot?.TOOL_256).toBeUndefined();
    expect(snapshot).toEqual(parseBoundedNullSeparatedEnvSnapshot(output));
  });

  it('keeps the parsed environment snapshot below its conservative payload limit', () => {
    expect(LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES).toBe(2 * 1024 * 1024);
    expect(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES).toBe(64 * 1024);
    const output = `PATH=/login/bin\0${'x'.repeat(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES)}\0`;

    expect(parseBoundedNullSeparatedEnvSnapshot(output)).toBeNull();
  });

  it('allows the Windows raw capture limit while bounding retained values and long Path', () => {
    const pathValue = 'C:\\tooling;'.padEnd(16 * 1024, 'x');
    const records = [
      `Path=${pathValue}`,
      ...Array.from({ length: 48 }, (_, index) => `TOOL_${index}=${'x'.repeat(1024)}`),
    ];
    const output = `${records.join('\0')}\0`;
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(output, {
      maxInputBytes: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
      maxPathEntryBytes: LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES,
    });

    expect(Buffer.byteLength(output)).toBeGreaterThan(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES);
    expect(Buffer.byteLength(output)).toBeLessThan(LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES);
    expect(snapshot?.Path).toBe(pathValue);
    expect(Object.entries(snapshot ?? {}).reduce(
      (total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`) + 1,
      0
    )).toBeLessThanOrEqual(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES);
  });

  it('retains a late Windows Path after preceding records exhaust the retained byte budget', () => {
    const pathValue = 'C:\\tooling;'.padEnd(
      LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES - 'Path='.length,
      'x'
    );
    const records = [
      ...Array.from({ length: 40 }, (_, index) => `TOOL_${index}=${'x'.repeat(2 * 1024)}`),
      `Path=${pathValue}`,
    ];
    const output = `${records.join('\0')}\0`;
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(output, {
      maxInputBytes: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
      maxPathEntryBytes: LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES,
    });

    expect(Buffer.byteLength(output)).toBeGreaterThan(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES);
    expect(snapshot?.Path).toBe(pathValue);
    expect(Object.entries(snapshot ?? {}).reduce(
      (total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`) + 1,
      0
    )).toBeLessThanOrEqual(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES);
  });

  it('retains a Windows PATH that appears after the 256-entry cap', () => {
    const records = [
      ...Array.from({ length: 300 }, (_, index) => `TOOL_${index}=value-${index}`),
      'PATH=C:\\tooling',
    ];
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(`${records.join('\0')}\0`, {
      maxInputBytes: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
      maxPathEntryBytes: LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES,
    });

    expect(Object.keys(snapshot ?? {})).toHaveLength(256);
    expect(snapshot?.PATH).toBe('C:\\tooling');
    expect(snapshot?.TOOL_0).toBe('value-0');
    expect(snapshot?.TOOL_254).toBe('value-254');
    expect(snapshot?.TOOL_255).toBeUndefined();
  });

  it('keeps the Windows Path allowance bounded', () => {
    const pathValue = 'x'.repeat(LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES);
    const snapshot = parseBoundedNullSeparatedEnvSnapshot(
      `Path=${pathValue}\0TOOL_HOME=/tools\0`,
      {
        maxInputBytes: LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
        maxPathEntryBytes: LOGIN_SHELL_ENV_MAX_WINDOWS_PATH_ENTRY_BYTES,
      }
    );

    expect(snapshot?.Path).toBeUndefined();
    expect(snapshot?.TOOL_HOME).toBe('/tools');
  });

  it('drops login output before the framed environment snapshot', () => {
    const noisyBanner = `INTERACTIVE_ONLY=unsafe\0${'startup banner\n'.repeat(Math.ceil((1.8 * 1024 * 1024) / 15))}`;
    const rawOutput = `${noisyBanner}${frameLoginShellEnv('PATH=/login/bin\0TOOL_HOME=/tools\0')}`;
    let options;
    const snapshot = captureLoginShellEnvSnapshot('/bin/sh', (_command, _args, spawnOptions) => {
      options = spawnOptions;
      return {
        status: 0,
        stdout: rawOutput,
      };
    });

    expect(snapshot).toMatchObject({
      PATH: '/login/bin',
      TOOL_HOME: '/tools',
    });
    expect(snapshot?.INTERACTIVE_ONLY).toBeUndefined();
    expect(Buffer.byteLength(rawOutput)).toBeGreaterThan(LOGIN_SHELL_ENV_MAX_SNAPSHOT_BYTES);
    expect(Buffer.byteLength(rawOutput)).toBeLessThan(LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES);
    expect(options.maxBuffer).toBe(LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES);
  });

  it('rejects failed or unframed login-shell captures', () => {
    const failed = captureLoginShellEnvSnapshot('/bin/sh', () => ({
      status: 1,
      stdout: frameLoginShellEnv('PATH=/login/bin\0'),
    }));
    const unframed = captureLoginShellEnvSnapshot('/bin/sh', () => ({
      status: 0,
      stdout: 'PATH=/login/bin\0',
    }));

    expect(failed).toBeNull();
    expect(unframed).toBeNull();
  });

  it('tries login-shell candidates in order after failed captures', () => {
    const calls = [];
    const snapshot = captureLoginShellEnvSnapshotFromCandidates(
      getLoginShellEnvCandidates('/invalid/configured-shell'),
      (command) => {
        calls.push(command);
        if (command === '/bin/sh') {
          return { status: 0, stdout: frameLoginShellEnv('PATH=/bin\0') };
        }
        return { status: 1, stdout: '' };
      }
    );

    expect(snapshot?.PATH).toBe('/bin');
    expect(calls).toEqual(['/invalid/configured-shell', '/bin/zsh', '/bin/bash', '/bin/sh']);
  });

  it('skips nushell when trying login-shell candidates', () => {
    const calls = [];
    const snapshot = captureLoginShellEnvSnapshotFromCandidates(
      ['/usr/bin/nu', '/bin/sh'],
      (command) => {
        calls.push(command);
        return { status: 0, stdout: frameLoginShellEnv('PATH=/bin\0') };
      }
    );

    expect(snapshot?.PATH).toBe('/bin');
    expect(calls).toEqual(['/bin/sh']);
  });
});
