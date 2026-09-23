import { describe, expect, test } from 'bun:test';
import type { ConsultMechanismCapability } from './capability';
import {
  CONSULT_BACKEND_PROTOCOL_VERSION,
  CONSULT_MIN_OPENCODE_VERSION,
  fetchConsultServerVersion,
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
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.29', consultProtocol: 2 })))
      .toEqual({ verified: true, version: '1.18.29' });
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.31', consultProtocol: 2 })))
      .toEqual({ verified: true, version: '1.18.31' });
    expect(await verifyConsultServerVersion(async () => ({ version: '2.0.0', consultProtocol: 2 })))
      .toEqual({ verified: true, version: '2.0.0' });
  });
});

describe('checking-version plumbing (WP-4)', () => {
  test('the capability union carries the checking-version refusal', () => {
    // The composer hook starts here; the union must accept it and the gate
    // must never be asked to resolve it as a version answer.
    const checking: ConsultMechanismCapability = { available: false, reason: 'checking-version' };
    expect(checking.reason).toBe('checking-version');
    expect(resolveConsultMechanismCapability({ serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'unverified' });
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
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.29', consultProtocol: 2 }), { serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'verified', version: '1.18.29' });
  });
});

describe('consult backend protocol gate', () => {
  test('the backend protocol floor is the queue protocol the UI speaks', () => {
    expect(CONSULT_BACKEND_PROTOCOL_VERSION).toBe(2);
  });

  test('a verified version with protocol 2 is available and verified', async () => {
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.31', consultProtocol: 2 }), { serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'verified', version: '1.18.31' });
  });

  test('a protocol-1 backend refuses as protocol-unsupported (the witness protocol)', async () => {
    // A protocol-1 backend predates the dispatch witness: its `resumable`
    // answer is not backed by "no attempt recorded", so this client refuses it.
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.31', consultProtocol: 1 })))
      .toEqual({ verified: false, reason: 'protocol-unsupported', protocol: 1 });
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.31', consultProtocol: 1 }), { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'protocol-unsupported' });
  });

  test('a backend without the protocol field refuses as protocol-missing', async () => {
    // The OpenCode version passes, but a backend that predates the field
    // ignores the consult `kind`: absence must refuse, never queue normally.
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.31' }), { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'protocol-missing' });
  });

  test('a malformed protocol reads as missing', async () => {
    for (const consultProtocol of ['1', null, 1.5]) {
      expect(await verifyConsultServerVersion(async () => ({ version: '1.18.31', consultProtocol })))
        .toEqual({ verified: false, reason: 'protocol-missing' });
    }
  });

  test('a protocol below the backend version refuses as protocol-unsupported', async () => {
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.31', consultProtocol: 0 })))
      .toEqual({ verified: false, reason: 'protocol-unsupported', protocol: 0 });
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.31', consultProtocol: 0 }), { serverQueueSupported: true }))
      .toEqual({ available: false, reason: 'protocol-unsupported' });
  });

  test('a protocol above the backend version is forward compatible', async () => {
    expect(await resolveConsultLiveCapability(async () => ({ version: '1.18.31', consultProtocol: 3 }), { serverQueueSupported: true }))
      .toEqual({ available: true, assurance: 'verified', version: '1.18.31' });
  });

  test('the version reason wins when the version is below the floor', async () => {
    expect(await verifyConsultServerVersion(async () => ({ version: '1.18.28', consultProtocol: 2 })))
      .toEqual({ verified: false, reason: 'version-unsupported', version: '1.18.28' });
  });

  test('a failing or unreadable version request stays version-unknown', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response('not json', { status: 404 });
      expect(await resolveConsultLiveCapability(undefined, { serverQueueSupported: true }))
        .toEqual({ available: false, reason: 'version-unknown' });
      globalThis.fetch = async () => {
        throw new Error('down');
      };
      expect(await resolveConsultLiveCapability(undefined, { serverQueueSupported: true }))
        .toEqual({ available: false, reason: 'version-unknown' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('fetchConsultServerVersion keeps the backend protocol from the payload', async () => {
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = async () => new Response(JSON.stringify({ version: '1.18.31', consultProtocol: 2 }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
      expect(await fetchConsultServerVersion()).toEqual({ version: '1.18.31', consultProtocol: 2 });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
