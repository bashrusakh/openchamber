import { beforeEach, describe, expect, test } from 'bun:test';
import type { Event, Session } from '@opencode-ai/sdk/v2/client';
import { switchRuntimeEndpoint } from '@/lib/runtime-switch';
import { useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useConsultPendingHideStore } from '@/stores/useConsultPendingHideStore';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import {
  partitionSidebarSessions,
  projectSidebarActiveSessions,
} from '@/components/session/sidebar/list/sessionCollection';
import { applySessionEventToGlobalSessions } from '../session-event-router';

/**
 * The sync path inserts `session.created`/`session.updated` straight into the
 * global session store. A fork whose marker has not landed yet is hidden by the
 * client-side pending-hide registry at the visibility boundary, while the data
 * store keeps the session so messages and titles still resolve.
 */

const DIRECTORY = '/workspace/consult';

const baseSession = (id: string, patch: Partial<Session> = {}): Session => ({
  id,
  slug: id,
  projectID: 'project',
  directory: DIRECTORY,
  title: id,
  version: '1',
  time: { created: 1, updated: 1 },
  ...patch,
});

// SAFETY: these fixtures match the SDK event shape consumed by the session
// event router (`properties.info` carries a Session).
const createdEvent = (session: Session): Event => ({
  type: 'session.created',
  properties: { info: session },
} as Event);

// SAFETY: see `createdEvent`; the router reads the same `properties.info`.
const updatedEvent = (session: Session): Event => ({
  type: 'session.updated',
  properties: { info: session },
} as Event);

const advisorMarker = (): SessionMetadataRecord => ({
  openchamber: {
    kind: 'consult-advisor',
    originalSessionID: 'parent-session',
    consultRunID: 'run-1',
    advisorIndex: 0,
  },
});

const visiblePartitionIds = (): string[] => projectSidebarActiveSessions({
  globalActiveSessions: useGlobalSessionsStore.getState().activeSessions,
  liveSessions: [],
  knownDirectories: new Set([DIRECTORY]),
  isVSCode: false,
}).map((session) => session.id);

describe('pending-hidden advisor forks in the sync event path', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'https://consult.test', runtimeKey: 'consult-test' });
    useGlobalSessionsStore.getState().resetForRuntimeSwitch();
    useConsultPendingHideStore.getState().resetForRuntimeSwitch();
  });

  test('a fork inserted by session.created while pending-hidden never reaches a visible partition', () => {
    applySessionEventToGlobalSessions(createdEvent(baseSession('ses_fork')));

    // The data store keeps the fork: only visibility is hidden, so messages,
    // titles, and deletion still resolve it.
    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toContain('ses_fork');
    expect(useGlobalSessionsStore.getState().entityById.has('ses_fork')).toBe(true);

    // The window between the fork call returning and the marker binding.
    useConsultPendingHideStore.getState().register('ses_fork');

    expect(partitionSidebarSessions(useGlobalSessionsStore.getState().activeSessions, false).projectSessions).toEqual([]);
    expect(visiblePartitionIds()).toEqual([]);

    // Releasing after the marker landed restores the session to the partition.
    useConsultPendingHideStore.getState().release('ses_fork');
    expect(visiblePartitionIds()).toEqual(['ses_fork']);
  });

  test('a marker-bound fork stays hidden without any registry entry', () => {
    applySessionEventToGlobalSessions(updatedEvent(baseSession('ses_advisor', {
      metadata: advisorMarker(),
    })));

    expect(useGlobalSessionsStore.getState().activeSessions.map((session) => session.id)).toEqual(['ses_advisor']);
    expect(useConsultPendingHideStore.getState().ids.size).toBe(0);
    expect(visiblePartitionIds()).toEqual([]);
    expect(partitionSidebarSessions(useGlobalSessionsStore.getState().activeSessions, false).projectSessions).toEqual([]);
  });

  test('a pending id hides an already-inserted fork without a new session event', () => {
    applySessionEventToGlobalSessions(createdEvent(baseSession('ses_fork')));
    expect(visiblePartitionIds()).toEqual(['ses_fork']);

    useConsultPendingHideStore.getState().register('ses_fork');
    expect(visiblePartitionIds()).toEqual([]);
  });
});
