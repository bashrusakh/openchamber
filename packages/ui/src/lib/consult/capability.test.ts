import { describe, expect, test } from 'bun:test';
import {
  CONSULT_MIN_OPENCODE_VERSION,
  isConsultVersionSupported,
  resolveConsultLiveCapability,
  resolveConsultMechanismCapability,
  verifyConsultServerVersion,
} from './capability';

describe('consult mechanism capability', () => {
  test('a runtime without the server-owned queue cannot host a consult', () => {
    expect(resolveConsultMechanismCapability({ serverQueueSupported: false }))
      .toEqual({ available: false, reason: 'unsupported-runtime' });
  });

  test('a server-queue runtime is available but explicitly unverified', () => {
    // The synchronous runtime gate cannot read a version; the accepted
    // deviation is the only available answer until the live gate resolves.
    expect(resolveConsultMechanismCapability({ serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'unverified' });
  });

  test('the default reads the live runtime gate', () => {
    // In a plain test environment there is no VS Code bootstrap, so the
    // runtime is treated as server-queue-capable and stays unverified.
    expect(resolveConsultMechanismCapability()).toEqual({ available: true, assurance: 'unverified' });
  });
});

describe('verifyConsultServerVersion (F3)', () => {
  test('the floor is the verified Phase 0 build', () => {
    expect(CONSULT_MIN_OPENCODE_VERSION).toBe('1.18.29');
  });

  test('refuses the build below the floor and accepts the floor and above', () => {
    expect(isConsultVersionSupported('1.18.28')).toBe(false);
    expect(isConsultVersionSupported('1.18.29')).toBe(true);
    expect(isConsultVersionSupported('1.18.31')).toBe(true);
    expect(isConsultVersionSupported('2.0.0')).toBe(true);
    expect(isConsultVersionSupported('1.19.0')).toBe(true);
    // Prerelease suffixes are ignored: numeric fields only, so 1.19.0-beta
    // counts as 1.19.0 and passes. Documented bound, not an accident.
    expect(isConsultVersionSupported('1.19.0-beta')).toBe(true);
    expect(isConsultVersionSupported('1.18.28')).toBe(false);
    expect(isConsultVersionSupported('v1.18.29')).toBe(true);
    expect(isConsultVersionSupported('1.18.29+build.7')).toBe(true);
  });

  test('an unreadable version is version-unknown, never assumed supported', async () => {
    expect(await verifyConsultServerVersion(async () => ({ version: null })))
      .toEqual({ verified: false, reason: 'version-unknown' });
    expect(await verifyConsultServerVersion(async () => ({ version: '' })))
      .toEqual({ verified: false, reason: 'version-unknown' });
    expect(await verifyConsultServerVersion(async () => ({ version: '   ' })))
      .toEqual({ verified: false, reason: 'version-unknown' });
    expect(await verifyConsultServerVersion(async () => ({ version: null, error: 'upstream down' })))
      .toEqual({ verified: false, reason: 'version-unknown' });
    expect(await verifyConsultServerVersion(async () => ({ version: 'not-a-version' })))
      .toEqual({ verified: false, reason: 'version-unknown', version: 'not-a-version' });
  });

  test('a fetch failure fails closed as version-unknown', async () => {
    const gate = await verifyConsultServerVersion(async () => {
      throw new Error('network down');
    });
    expect(gate).toEqual({ verified: false, reason: 'version-unknown' });
  });

  test('a real version below the floor is version-unsupported with the version attached', async () => {
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.28' })))
      .toEqual({ verified: false, reason: 'version-unsupported', version: '1.18.28' });
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.29' })))
      .toEqual({ verified: true, version: '1.18.29' });
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.31' })))
      .toEqual({ verified: true, version: '1.18.31' });
    expect(await verifyConsultServerVersion(async () => ({ version: '2.0.0' })))
      .toEqual({ verified: true, version: '2.0.0' });
  });
});

describe('resolveConsultLiveCapability (F3)', () => {
  test('an unsupported runtime refuses before any version read', async () => {
    let fetched = false;
    const capability = await resolveConsultLiveCapability(
      async () => {
        fetched = true;
        return { version: '1.18.31' };
      },
      { serverQueueSupported: false },
    );
    expect(capability).toEqual({ available: false, reason: 'unsupported-runtime' });
    expect(fetched).toBe(false);
  });

  test('an unknown version refuses fail-closed', async () => {
    expect(await resolveConsultLiveCapability(async () => ({ version: null }), { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'version-unknown' });
    expect(await resolveConsultLiveCapability(async () => {
      throw new Error('down');
    }, { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'version-unknown' });
  });

  test('a version below the floor refuses with the version attached', async () => {
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.28' }), { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'version-unsupported', version: '1.18.28' });
  });

  test('a version at or above the floor is verified', async () => {
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.29' }), { serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'verified', version: '1.18.29' });
  });
});
