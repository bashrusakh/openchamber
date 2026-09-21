import { create } from 'zustand';

/**
 * Client-side pending-hide registry for Consult Models advisor forks.
 *
 * `session.fork` cannot bind the hidden marker atomically: the fork id only
 * exists once the HTTP call returns, while the server can publish
 * `session.created`/`session.updated` into the session lists first (see
 * `sync/event-reducer.ts` and `sync/session-event-router.ts`). The advisor
 * runtime therefore registers the returned fork id here immediately after the
 * fork call, binds the `openchamber.kind = 'consult-advisor'` marker as its
 * first follow-up write, and releases the id once the marker is readable.
 *
 * This is transient client state, not session authority:
 *
 * - Memory-only and runtime-scoped. A runtime switch drops every entry, since
 *   neither the fork ids nor the pending markers belong to the new instance.
 * - It never hides a session from the data stores. The registry is honored
 *   only at the visibility boundary (`lib/sessionVisibility.ts`), so messages,
 *   titles, and deletion keep working for a session that is hidden in lists.
 * - An entry without a marker is a leak candidate, not a hidden session: the
 *   marker (WP1.1) is what keeps a fork out of the surfaces after the window.
 */
type ConsultPendingHideStore = {
  ids: ReadonlySet<string>;
  register: (sessionId: string) => void;
  release: (sessionId: string) => void;
  isPendingHidden: (sessionId: string) => boolean;
  resetForRuntimeSwitch: () => void;
};

const EMPTY_PENDING_HIDDEN_IDS: ReadonlySet<string> = new Set();

export const useConsultPendingHideStore = create<ConsultPendingHideStore>()((set, get) => ({
  ids: EMPTY_PENDING_HIDDEN_IDS,
  register: (sessionId) => {
    if (!sessionId || get().ids.has(sessionId)) return;
    const ids = new Set(get().ids);
    ids.add(sessionId);
    set({ ids });
  },
  release: (sessionId) => {
    if (!get().ids.has(sessionId)) return;
    const ids = new Set(get().ids);
    ids.delete(sessionId);
    set({ ids });
  },
  isPendingHidden: (sessionId) => get().ids.has(sessionId),
  resetForRuntimeSwitch: () => {
    if (get().ids.size === 0) return;
    set({ ids: EMPTY_PENDING_HIDDEN_IDS });
  },
}));

/** Non-React read for the visibility predicate and other module-level filters. */
export const getPendingHiddenSessionIds = (): ReadonlySet<string> =>
  useConsultPendingHideStore.getState().ids;

/**
 * React subscription for filters that must recompute when a fork is registered
 * or released. The set reference only changes on an actual mutation, so
 * unaffected consumers keep their memoized projections.
 */
export const usePendingHiddenSessionIds = (): ReadonlySet<string> =>
  useConsultPendingHideStore((state) => state.ids);
