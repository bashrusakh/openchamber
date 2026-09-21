import { beforeEach, describe, expect, test } from 'bun:test';
import type { Session } from '@opencode-ai/sdk/v2';
import { useConsultPendingHideStore } from '@/stores/useConsultPendingHideStore';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import { filterVisibleSessions, isHiddenSession } from './sessionVisibility';

// SAFETY: the visibility predicate reads only id and metadata; the SDK Session
// shape is irrelevant to these fixtures.
const sessionWith = (id: string, metadata?: Session['metadata']): Session => ({ id, metadata }) as Session;

const btwFork = (id: string): Session =>
  sessionWith(id, { openchamber: { kind: 'btw', originalSessionID: 'parent' } });

const advisorFork = (id: string, patch: SessionMetadataRecord = {}): Session =>
  sessionWith(id, {
    openchamber: {
      kind: 'consult-advisor',
      originalSessionID: 'parent',
      consultRunID: 'run-1',
      advisorIndex: 0,
      ...patch,
    },
  });

describe('isHiddenSession', () => {
  beforeEach(() => {
    useConsultPendingHideStore.setState({ ids: new Set() });
  });

  test('keeps a normal session visible', () => {
    expect(isHiddenSession(sessionWith('plain'))).toBe(false);
    expect(isHiddenSession(sessionWith('review-like', { openchamber: { kind: 'review' } }))).toBe(false);
    expect(isHiddenSession(null)).toBe(false);
    expect(isHiddenSession(undefined)).toBe(false);
  });

  test('hides a btw fork and shows it again once promoted', () => {
    expect(isHiddenSession(btwFork('fork'))).toBe(true);
    expect(isHiddenSession(sessionWith('promoted', { openchamber: { btwPromoted: true } }))).toBe(false);
  });

  test('hides an advisor fork even when its index is unusable', () => {
    expect(isHiddenSession(advisorFork('advisor'))).toBe(true);
    expect(isHiddenSession(advisorFork('advisor', { advisorIndex: 'zero' }))).toBe(true);
  });

  test('does not hide an unreadable advisor marker', () => {
    // The marker contract requires both identity fields; a malformed object is
    // not a valid fork marker and must not hide an arbitrary session.
    expect(isHiddenSession(sessionWith('broken', {
      openchamber: { kind: 'consult-advisor', originalSessionID: 'parent' },
    }))).toBe(false);
  });

  test('hides a registered pending id and shows it again after release', () => {
    const fork = sessionWith('pending-fork');
    expect(isHiddenSession(fork)).toBe(false);

    useConsultPendingHideStore.getState().register('pending-fork');
    expect(isHiddenSession(fork)).toBe(true);
    expect(isHiddenSession(sessionWith('other'))).toBe(false);

    useConsultPendingHideStore.getState().release('pending-fork');
    expect(isHiddenSession(fork)).toBe(false);
  });
});

describe('filterVisibleSessions', () => {
  beforeEach(() => {
    useConsultPendingHideStore.setState({ ids: new Set() });
  });

  test('drops hidden sessions and preserves the order and identity of the rest', () => {
    const plain = sessionWith('plain');
    const btw = btwFork('btw');
    const advisor = advisorFork('advisor');
    const pending = sessionWith('pending');
    useConsultPendingHideStore.getState().register('pending');

    const visible = filterVisibleSessions([plain, btw, advisor, pending]);

    expect(visible).toEqual([plain]);
    expect(visible[0]).toBe(plain);
  });
});
