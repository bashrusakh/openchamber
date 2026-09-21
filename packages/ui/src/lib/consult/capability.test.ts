import { describe, expect, test } from 'bun:test';
import { resolveConsultMechanismCapability } from './capability';

describe('consult mechanism capability', () => {
  test('a runtime without the server-owned queue cannot host a consult', () => {
    expect(resolveConsultMechanismCapability({ serverQueueSupported: false }))
      .toEqual({ available: false, reason: 'unsupported-runtime' });
  });

  test('a server-queue runtime is available but explicitly unverified', () => {
    // No version/capability surface can confirm the transport half of the
    // mechanism, so the accepted deviation is the only available answer.
    expect(resolveConsultMechanismCapability({ serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'unverified' });
  });

  test('the default reads the live runtime gate', () => {
    // In a plain test environment there is no VS Code bootstrap, so the
    // runtime is treated as server-queue-capable and stays unverified.
    expect(resolveConsultMechanismCapability()).toEqual({ available: true, assurance: 'unverified' });
  });
});
