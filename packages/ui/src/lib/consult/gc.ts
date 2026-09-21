import type { Session } from '@opencode-ai/sdk/v2';
import { getRuntimeKey, subscribeRuntimeEndpointWillChange } from '@/lib/runtime-switch';
import { isConsultRunActive } from '@/lib/consult/runtime';
import { getConsultRunID, isConsultAdvisorSession } from '@/lib/consult/metadata';
import { resolveGlobalSessionDirectory, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useConsultPendingHideStore } from '@/stores/useConsultPendingHideStore';
import * as sessionActions from '@/sync/session-actions';

/**
 * Stale-fork GC for Consult Models advisor sessions (WP1.4).
 *
 * The advisor runtime deletes its forks after every run, but a fork can survive
 * a failed delete, a lost page, or a crash between the fork call and the marker
 * write. Leftover forks stay hidden by their marker, so the only way they
 * disappear is this sweep.
 *
 * A fork is swept only when all three hold:
 *
 * 1. its marker parses as `kind: 'consult-advisor'` (the marker schema is the
 *    read boundary; a malformed marker is never a deletion candidate);
 * 2. its `consultRunID` is not in the active-run registry — a live run's forks
 *    are never touched, even if the clock says they are old;
 * 3. it is older than the threshold (default 60 min), measured from its last
 *    activity, so a fork that is still receiving its advisor reply cannot be
 *    collected.
 *
 * The sweep stops as soon as the runtime changes: session IDs are not unique
 * across runtimes, and a delete issued against the new runtime for an old
 * session id could remove an unrelated session. The captured runtime key is
 * also passed to the delete action, which enforces the same guard.
 */

export const CONSULT_GC_THRESHOLD_MS = 60 * 60 * 1000;

export type ConsultGcDeps = {
  /** Sessions this client currently holds (global active + archived). */
  listSessions: () => readonly Session[];
  /** Delete one session; the captured runtime key scopes the mutation. */
  deleteSession: (sessionId: string, directory: string, expectedRuntimeKey: string) => Promise<boolean>;
  /** True while a consultation run is live and owns its forks. */
  isRunActive: (runId: string) => boolean;
  /** Releases the pending-hide entry of a deleted fork. */
  releasePendingHide?: (sessionId: string) => void;
  runtimeKey: () => string;
  /** Notifies the sweep that the runtime is about to change; the sweep stops. */
  subscribeRuntimeChange?: (listener: () => void) => () => void;
  now: () => number;
  /** Overrides the 60-minute default. */
  thresholdMs?: number;
};

export type ConsultGcSweepResult = {
  deletedIds: string[];
  failedIds: string[];
  skippedReason?: 'runtime-changed';
};

const isOlderThanThreshold = (session: Session, cutoff: number): boolean => {
  const timestamp = session.time.updated ?? session.time.created;
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp < cutoff;
};

export const sweepStaleAdvisorForks = async (deps: ConsultGcDeps): Promise<ConsultGcSweepResult> => {
  const result: ConsultGcSweepResult = { deletedIds: [], failedIds: [] };
  const runtimeKey = deps.runtimeKey();
  let runtimeChanged = false;
  const unsubscribe = deps.subscribeRuntimeChange?.(() => {
    runtimeChanged = true;
  });
  const isCurrentRuntime = () => !runtimeChanged && deps.runtimeKey() === runtimeKey;

  try {
    const cutoff = deps.now() - (deps.thresholdMs ?? CONSULT_GC_THRESHOLD_MS);
    const candidates = deps.listSessions().filter((session) => {
      if (!isConsultAdvisorSession(session)) return false;
      const runId = getConsultRunID(session);
      // The marker schema guarantees a run id; a session that parses without
      // one is malformed and stays untouched.
      if (!runId || deps.isRunActive(runId)) return false;
      return isOlderThanThreshold(session, cutoff);
    });

    for (const session of candidates) {
      if (!isCurrentRuntime()) return { ...result, skippedReason: 'runtime-changed' };
      const directory = resolveGlobalSessionDirectory(session);
      if (!directory) {
        result.failedIds.push(session.id);
        continue;
      }
      let deleted = false;
      try {
        deleted = await deps.deleteSession(session.id, directory, runtimeKey);
      } catch {
        // One failed fork never blocks the others; the parent is untouched.
        deleted = false;
      }
      if (!deleted) {
        result.failedIds.push(session.id);
        continue;
      }
      result.deletedIds.push(session.id);
      // A fork that never received a marker can still hold a pending-hide
      // entry; deleting it makes that entry meaningless.
      deps.releasePendingHide?.(session.id);
    }
    return result;
  } finally {
    unsubscribe?.();
  }
};

/** Live wiring for the app-load and parent-visit sweep. */
export const sweepStaleConsultAdvisorForks = (): Promise<ConsultGcSweepResult> => sweepStaleAdvisorForks({
  listSessions: () => {
    const global = useGlobalSessionsStore.getState();
    return [...global.activeSessions, ...global.archivedSessions];
  },
  deleteSession: (sessionId, directory, expectedRuntimeKey) =>
    sessionActions.deleteSessionInDirectory(sessionId, directory, expectedRuntimeKey),
  isRunActive: isConsultRunActive,
  releasePendingHide: (sessionId) => useConsultPendingHideStore.getState().release(sessionId),
  runtimeKey: getRuntimeKey,
  subscribeRuntimeChange: subscribeRuntimeEndpointWillChange,
  now: () => Date.now(),
});
