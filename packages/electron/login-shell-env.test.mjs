import assert from 'node:assert/strict';
import test from 'node:test';

import {
  captureLoginShellEnvSnapshot,
  LOGIN_SHELL_ENV_COMMAND,
  LOGIN_SHELL_ENV_END_MARKER,
  LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES,
  LOGIN_SHELL_ENV_START_MARKER,
  LOGIN_SHELL_ENV_TIMEOUT_MS,
  captureLoginShellEnvSnapshotFromCandidates,
  getLoginShellEnvCandidates,
} from '../web/server/lib/opencode/login-shell-env.js';

const frameLoginShellEnv = (records) => (
  `\0${LOGIN_SHELL_ENV_START_MARKER}\0${records}${LOGIN_SHELL_ENV_END_MARKER}\0`
);

test('Desktop uses the bounded noninteractive login shell capture shared with web', () => {
  let call;
  const snapshot = captureLoginShellEnvSnapshot('/bin/sh', (command, args, options) => {
    call = { command, args, options };
    return {
      status: 0,
      stdout: Buffer.from(`\0${LOGIN_SHELL_ENV_START_MARKER}\0PATH=/desktop/bin\0TOOL_HOME=/tools\0${LOGIN_SHELL_ENV_END_MARKER}\0`),
    };
  });

  assert.deepEqual({ ...snapshot }, {
    PATH: '/desktop/bin',
    TOOL_HOME: '/tools',
  });
  assert.equal(call.command, '/bin/sh');
  assert.deepEqual(call.args, ['-l', '-c', LOGIN_SHELL_ENV_COMMAND]);
  assert.equal(call.args.includes('-i'), false);
  assert.match(call.args[2], /command env -0/);
  assert.equal(call.options.maxBuffer, LOGIN_SHELL_ENV_MAX_CAPTURE_BYTES);
  assert.equal(call.options.timeout, LOGIN_SHELL_ENV_TIMEOUT_MS);
  assert.equal(call.options.encoding, 'utf8');
});

test('Desktop falls back from an invalid configured shell to /bin/sh', () => {
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

  assert.equal(snapshot?.PATH, '/bin');
  assert.deepEqual(calls, ['/invalid/configured-shell', '/bin/zsh', '/bin/bash', '/bin/sh']);
});

test('Desktop rejects empty, unframed, and nonzero login-shell captures', () => {
  assert.equal(
    captureLoginShellEnvSnapshot('/bin/sh', () => ({ status: 0, stdout: '' })),
    null
  );
  assert.equal(
    captureLoginShellEnvSnapshot('/bin/sh', () => ({ status: 0, stdout: 'PATH=/bin\0' })),
    null
  );
  assert.equal(
    captureLoginShellEnvSnapshot('/bin/sh', () => ({
      status: 1,
      stdout: frameLoginShellEnv('PATH=/bin\0'),
    })),
    null
  );
});
