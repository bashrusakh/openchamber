import { describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import {
  getConsultOriginalSessionID,
  getConsultRunID,
  isConsultAdvisorSession,
  withConsultAdvisorMarker,
} from './metadata';

const sessionWith = (metadata: Session['metadata']): Session => ({
  id: 'advisor-1',
  slug: 'advisor-1',
  projectID: 'project-1',
  directory: '/tmp/project',
  title: 'Advisor fork',
  version: '1.24.2',
  metadata,
  time: { created: 0, updated: 0 },
});

const markerInput = {
  originalSessionID: 'parent-1',
  consultRunID: 'run-1',
  advisorIndex: 2,
};

const markedOpenchamber = {
  kind: 'consult-advisor',
  originalSessionID: 'parent-1',
  consultRunID: 'run-1',
  advisorIndex: 2,
};

describe('advisor marker', () => {
  test('withConsultAdvisorMarker writes the full marker and preserves unrelated metadata', () => {
    expect(withConsultAdvisorMarker({ other: 1 }, markerInput)).toEqual({
      other: 1,
      openchamber: markedOpenchamber,
    });
  });

  test('the marker round-trips through the readers', () => {
    const session = sessionWith(withConsultAdvisorMarker({}, markerInput));
    expect(isConsultAdvisorSession(session)).toBe(true);
    expect(getConsultOriginalSessionID(session)).toBe('parent-1');
    expect(getConsultRunID(session)).toBe('run-1');
  });

  test('the marker survives a JSON round-trip, the way it is persisted', () => {
    const written = withConsultAdvisorMarker({}, markerInput);
    const session = sessionWith(JSON.parse(JSON.stringify(written)));
    expect(isConsultAdvisorSession(session)).toBe(true);
    expect(getConsultOriginalSessionID(session)).toBe('parent-1');
    expect(getConsultRunID(session)).toBe('run-1');
  });

  test('withConsultAdvisorMarker replaces inherited openchamber metadata instead of merging it', () => {
    const inherited = {
      openchamber: { kind: 'btw', originalSessionID: 'older-parent', btwSessionID: 'stale-fork' },
      other: 1,
    };
    expect(withConsultAdvisorMarker(inherited, markerInput)).toEqual({
      other: 1,
      openchamber: markedOpenchamber,
    });
  });

  test('withConsultAdvisorMarker refuses input the readers could not recognize', () => {
    expect(() => withConsultAdvisorMarker({}, { ...markerInput, originalSessionID: '  ' })).toThrow();
    expect(() => withConsultAdvisorMarker({}, { ...markerInput, consultRunID: '  ' })).toThrow();
    expect(() => withConsultAdvisorMarker({}, { ...markerInput, advisorIndex: -1 })).toThrow();
    expect(() => withConsultAdvisorMarker({}, { ...markerInput, advisorIndex: 1.5 })).toThrow();
  });
});

describe('reader guards', () => {
  test('absent or malformed metadata never throws and reads as "not an advisor"', () => {
    const malformed: Array<Session['metadata']> = [
      undefined,
      {},
      { openchamber: null },
      { openchamber: 'nope' },
      { openchamber: [] },
      { openchamber: 7 },
      { openchamber: { kind: 'consult-advisor' } },
      { openchamber: { kind: 'consult-advisor', originalSessionID: 'parent-1' } },
      { openchamber: { kind: 'consult-advisor', originalSessionID: 'parent-1', consultRunID: 7 } },
      { openchamber: { kind: 'consult-advisor', originalSessionID: 'parent-1', consultRunID: '   ' } },
    ];
    for (const metadata of malformed) {
      const session = sessionWith(metadata);
      expect(isConsultAdvisorSession(session)).toBe(false);
      expect(getConsultOriginalSessionID(session)).toBeNull();
      expect(getConsultRunID(session)).toBeNull();
    }
    expect(isConsultAdvisorSession(null)).toBe(false);
    expect(isConsultAdvisorSession(undefined)).toBe(false);
    expect(getConsultOriginalSessionID(null)).toBeNull();
  });

  test('kind plus run id is the marker: a partial marker still hides and is GC-eligible', () => {
    // The notification server suppresses on these same two fields, so a fork
    // whose write dropped the parent id or the index must behave identically
    // here rather than staying visible and uncollectable.
    const partial = sessionWith({ openchamber: { kind: 'consult-advisor', consultRunID: 'run-1' } });
    expect(isConsultAdvisorSession(partial)).toBe(true);
    expect(getConsultRunID(partial)).toBe('run-1');
    expect(getConsultOriginalSessionID(partial)).toBeNull();

    for (const originalSessionID of ['   ', 7, null]) {
      const session = sessionWith({
        openchamber: { kind: 'consult-advisor', consultRunID: 'run-1', originalSessionID, advisorIndex: 'nope' },
      });
      expect(isConsultAdvisorSession(session)).toBe(true);
      expect(getConsultOriginalSessionID(session)).toBeNull();
    }
  });

  test('another fork kind does not match', () => {
    for (const kind of ['btw', 'review']) {
      const session = sessionWith({
        openchamber: { kind, originalSessionID: 'parent-1', consultRunID: 'run-1', advisorIndex: 0 },
      });
      expect(isConsultAdvisorSession(session)).toBe(false);
      expect(getConsultOriginalSessionID(session)).toBeNull();
      expect(getConsultRunID(session)).toBeNull();
    }
  });
});
