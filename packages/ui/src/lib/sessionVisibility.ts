import type { Session } from '@opencode-ai/sdk/v2';
import { isBtwSession } from '@/lib/sessionBtwMetadata';
import { isConsultAdvisorSession } from '@/lib/consult/metadata';
import { getPendingHiddenSessionIds } from '@/stores/useConsultPendingHideStore';

/**
 * Canonical session-visibility boundary.
 *
 * Every session list, counter, tab strip, widget snapshot, palette, and
 * navigation projection decides membership through `isHiddenSession` (or
 * `filterVisibleSessions`) instead of checking `openchamber.kind` inline, so a
 * new hidden session kind cannot leak through one surface that forgot its own
 * check.
 *
 * Hidden today:
 * - `/btw` forks (`isBtwSession`) — visible again only when promoted.
 * - Consult Models advisor forks (`isConsultAdvisorSession`).
 * - Fork ids in the pending-hide registry — the window between `session.fork`
 *   returning and the advisor marker landing (WP1.2). `usePendingHiddenSessionIds`
 *   is the matching React subscription for filters that must recompute when
 *   that window opens or closes; React filters pass that subscribed set as the
 *   second argument so their memo dependencies are real, while non-React
 *   callers fall back to the live registry read.
 *
 * Review sessions are intentionally NOT hidden here: they surface in the
 * sidebar today, and this module only consolidates existing behavior plus the
 * advisor kind.
 *
 * This boundary is presentation-only. The session data stores keep every
 * hidden session, so messages, titles, deletion, and cleanup still resolve it;
 * only the projections that render sessions consult this module.
 */
export const isHiddenSession = (
  session: Session | null | undefined,
  pendingHiddenIds: ReadonlySet<string> = getPendingHiddenSessionIds(),
): boolean => {
  if (!session) return false;
  if (isBtwSession(session)) return true;
  if (isConsultAdvisorSession(session)) return true;
  return pendingHiddenIds.has(session.id);
};

export const filterVisibleSessions = (
  sessions: readonly Session[],
  pendingHiddenIds?: ReadonlySet<string>,
): Session[] => sessions.filter((session) => !isHiddenSession(session, pendingHiddenIds));
