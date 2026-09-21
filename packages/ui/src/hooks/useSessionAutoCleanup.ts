import React from 'react';
import type { Session } from '@opencode-ai/sdk/v2';
import { sweepStaleConsultAdvisorForks } from '@/lib/consult/gc';
import { ensureGlobalSessionsLoaded, useGlobalSessionsStore } from '@/stores/useGlobalSessionsStore';
import { useSessionUIStore } from '@/sync/session-ui-store';
import { useGlobalSessionStatusStore } from '@/sync/global-session-status';
import {
  buildSessionRetentionCandidates,
  RETENTION_INTERVAL_MS,
  RETENTION_KEEP_RECENT,
  runSessionRetentionCleanup,
  useSessionRetentionRunStore,
} from '@/sync/session-retention';
import { useUIStore } from '@/stores/useUIStore';

const EMPTY_SESSIONS: Session[] = [];
type CleanupOptions = { autoRun?: boolean; enabled?: boolean };

export const useSessionAutoCleanup = ({ autoRun = true, enabled = true }: CleanupOptions = {}) => {
  const currentSessionId = useSessionUIStore((state) => state.currentSessionId);
  const isLoading = useSessionUIStore((state) => state.isLoading);
  const autoDeleteEnabled = useUIStore((state) => state.autoDeleteEnabled);
  const autoDeleteAfterDays = useUIStore((state) => state.autoDeleteAfterDays);
  const onlyArchived = useUIStore((state) => state.sessionRetentionOnlyArchived);
  const action = useUIStore((state) => state.sessionRetentionOnlyArchived ? 'delete' : state.sessionRetentionAction);
  const autoDeleteLastRunAt = useUIStore((state) => state.autoDeleteLastRunAt);
  // The retention candidate projection is only needed where retention can run
  // (the settings surface previews candidates with `autoRun: false`), but the
  // consult fork sweep always reads the authoritative global cache, so the
  // cache loads whenever cleanup is enabled.
  const needsRetentionSessions = enabled && (!autoRun || autoDeleteEnabled);
  const activeSessions = useGlobalSessionsStore((state) => needsRetentionSessions ? state.activeSessions : EMPTY_SESSIONS);
  const archivedSessions = useGlobalSessionsStore((state) => needsRetentionSessions ? state.archivedSessions : EMPTY_SESSIONS);
  const status = useGlobalSessionsStore((state) => state.status);
  const activeSessionIds = useGlobalSessionStatusStore((state) => state.activeSessionIds);
  const isRunning = useSessionRetentionRunStore((state) => state.isRunning);

  React.useEffect(() => {
    if (enabled) void ensureGlobalSessionsLoaded();
  }, [enabled]);

  const candidates = React.useMemo(() => buildSessionRetentionCandidates({
    sessions: [...activeSessions, ...archivedSessions],
    currentSessionId,
    cutoffDays: autoDeleteAfterDays,
    action,
    onlyArchived,
    activeSessionIds,
  }), [activeSessions, archivedSessions, currentSessionId, autoDeleteAfterDays, action, onlyArchived, activeSessionIds]);

  React.useEffect(() => {
    if (!enabled || !autoRun || !autoDeleteEnabled || autoDeleteAfterDays <= 0
      || isLoading || status !== 'ready' || isRunning) return;
    if (autoDeleteLastRunAt && Date.now() - autoDeleteLastRunAt < RETENTION_INTERVAL_MS) return;
    void runSessionRetentionCleanup().catch((error) => {
      console.error('[SessionRetention] Cleanup failed', error);
    });
  }, [enabled, autoRun, autoDeleteEnabled, autoDeleteAfterDays, isLoading, status, isRunning, autoDeleteLastRunAt]);

  // Advisor forks can survive a failed delete, a lost page, or a crash between
  // the fork call and the marker write. The sweep is idempotent: it only touches
  // marker-validated forks whose run is not active and whose last activity is
  // older than the threshold, and it stops itself when the runtime changes. Run
  // it once the global session cache is authoritative and on every session
  // visit (the parent-visit sweep); never block startup on it. The sweep is
  // deliberately independent of `autoRun`: an embedded chat or the settings
  // surface must not accumulate hidden forks either. The explicit bound is
  // `enabled: false` (a hidden embedded chat does not sweep).
  React.useEffect(() => {
    if (!enabled || status !== 'ready') return;
    void sweepStaleConsultAdvisorForks().catch((error) => {
      console.error('[ConsultGC] Stale advisor fork sweep failed', error);
    });
  }, [enabled, status, currentSessionId]);

  return {
    candidates,
    isRunning,
    status,
    runCleanup: runSessionRetentionCleanup,
    keepRecentCount: RETENTION_KEEP_RECENT,
    action,
  };
};
