import { create } from 'zustand';

/**
 * Transient progress state for a Consult Models run, one record per parent
 * session.
 *
 * This store is presentation only. The run's authority lives elsewhere: the
 * advisor forks are named by session metadata (`openchamber.kind =
 * 'consult-advisor'`), the work is executed by `lib/consult/runtime.ts`, and
 * the receipt is carried as bounded part metadata on the acting user message.
 * The store exists so the composer action, the progress panel, and the Cancel
 * button render the same run, and it is memory-only.
 *
 * Invariants:
 *
 * - one record per `parentSessionId`; starting a new run replaces the previous
 *   record, so a session never shows two runs at once;
 * - every mutation is bound to the record's `runId`, so a superseded run's late
 *   completion cannot move the new run's phase or advisor rows (plan §8, "late
 *   results are ignored");
 * - `setPhase(..., 'idle')` removes the record, which is how the progress panel
 *   dismisses a finished run;
 * - unaffected sessions keep their record and map-entry references, so a
 *   per-session subscriber only re-renders for its own run.
 *
 * Phases: `waiting-admission` (the consult item waits at the queue head for an
 * authoritatively idle session) → `consulting` (advisor forks run) → `settling`
 * (results are collected and forks cleaned) → `dispatching` (the acting turn is
 * sent with the guidance) → `done`. `failed` is the run itself failing, and
 * `cancelled` is a user cancel before dispatch.
 */
export type ConsultRunPhase =
  | 'idle'
  | 'waiting-admission'
  | 'consulting'
  | 'settling'
  | 'dispatching'
  | 'done'
  | 'failed'
  | 'cancelled';

export type ConsultRunMode = 'parallel' | 'sequential';

/**
 * Advisor row status. The terminal values match the runtime's provenance
 * vocabulary, so a finished result maps onto the rows without translation;
 * `queued` and `running` are the pre-terminal states the panel shows.
 */
export type ConsultAdvisorRunStatus =
  | 'queued'
  | 'running'
  | 'ok'
  | 'failed'
  | 'timeout'
  | 'empty'
  | 'cancelled';

/** One advisor as the picker submits it. */
export type ConsultAdvisorInput = {
  providerID: string;
  modelID: string;
  /** Exact agent the advisor runs under; primary agents only. */
  agent: string;
  /** Thinking level; absent or null means the model default. */
  variant?: string | null;
};

/** One advisor row as the panel renders it. */
export type ConsultAdvisorProgress = {
  /** Position in the submitted list; updates match on it. */
  index: number;
  providerID: string;
  modelID: string;
  agent: string;
  variant?: string;
  status: ConsultAdvisorRunStatus;
  durationMs?: number;
  reason?: string;
};

export type ConsultRunProgress = {
  runId: string;
  phase: ConsultRunPhase;
  mode: ConsultRunMode;
  timeoutMs: number;
  advisors: readonly ConsultAdvisorProgress[];
  /** Set by `finish` on a `done` run that produced no usable advisor output. */
  degraded: boolean;
  /** Why the run failed, when it did. */
  error?: string;
};

export type ConsultRunStartInput = {
  parentSessionId: string;
  runId: string;
  mode: ConsultRunMode;
  timeoutMs: number;
  advisors: readonly ConsultAdvisorInput[];
};

/** A live update for one advisor; an absent field keeps the stored value. */
export type ConsultAdvisorUpdate = {
  status?: ConsultAdvisorRunStatus;
  durationMs?: number;
  reason?: string;
};

/** Final per-advisor outcome applied by `finish`. */
export type ConsultAdvisorOutcome = {
  index: number;
  status: ConsultAdvisorRunStatus;
  durationMs?: number;
  reason?: string;
};

export type ConsultRunFinish = {
  /** Terminal phase; a finished run stays visible until it is dismissed. */
  phase: 'done' | 'failed' | 'cancelled';
  /** Only recorded for a `done` run. */
  degraded?: boolean;
  error?: string;
  advisors?: readonly ConsultAdvisorOutcome[];
};

type ConsultStore = {
  runsByParentSessionId: Record<string, ConsultRunProgress>;
  startRun: (input: ConsultRunStartInput) => void;
  setPhase: (parentSessionId: string, runId: string, phase: ConsultRunPhase) => void;
  updateAdvisor: (
    parentSessionId: string,
    runId: string,
    index: number,
    update: ConsultAdvisorUpdate,
  ) => void;
  finish: (parentSessionId: string, runId: string, summary: ConsultRunFinish) => void;
  cancel: (parentSessionId: string, runId: string) => void;
  resetForRuntimeSwitch: () => void;
};

const NO_RUNS: Record<string, ConsultRunProgress> = {};

const isTerminalPhase = (phase: ConsultRunPhase): boolean =>
  phase === 'done' || phase === 'failed' || phase === 'cancelled';

const toAdvisorProgress = (advisor: ConsultAdvisorInput, index: number): ConsultAdvisorProgress => {
  const progress: ConsultAdvisorProgress = {
    index,
    providerID: advisor.providerID,
    modelID: advisor.modelID,
    agent: advisor.agent,
    status: 'queued',
  };
  if (advisor.variant) progress.variant = advisor.variant;
  return progress;
};

/** Returns the same advisor reference when the update changes nothing. */
const applyAdvisorUpdate = (
  advisor: ConsultAdvisorProgress,
  update: ConsultAdvisorUpdate,
): ConsultAdvisorProgress => {
  const status = update.status ?? advisor.status;
  const durationMs = update.durationMs ?? advisor.durationMs;
  const reason = update.reason ?? advisor.reason;
  if (status === advisor.status && durationMs === advisor.durationMs && reason === advisor.reason) {
    return advisor;
  }
  const next: ConsultAdvisorProgress = { ...advisor, status };
  if (durationMs !== undefined) next.durationMs = durationMs;
  if (reason !== undefined) next.reason = reason;
  return next;
};

const applyAdvisorOutcomes = (
  advisors: readonly ConsultAdvisorProgress[],
  outcomes: readonly ConsultAdvisorOutcome[],
): readonly ConsultAdvisorProgress[] => {
  let changed = false;
  const next = advisors.map((advisor) => {
    const outcome = outcomes.find((candidate) => candidate.index === advisor.index);
    if (!outcome) return advisor;
    const updated = applyAdvisorUpdate(advisor, outcome);
    if (updated !== advisor) changed = true;
    return updated;
  });
  return changed ? next : advisors;
};

export const useConsultStore = create<ConsultStore>()((set, get) => ({
  runsByParentSessionId: NO_RUNS,

  startRun: (input) =>
    set((state) => ({
      runsByParentSessionId: {
        ...state.runsByParentSessionId,
        [input.parentSessionId]: {
          runId: input.runId,
          phase: 'waiting-admission',
          mode: input.mode,
          timeoutMs: input.timeoutMs,
          advisors: input.advisors.map(toAdvisorProgress),
          degraded: false,
        },
      },
    })),

  setPhase: (parentSessionId, runId, phase) =>
    set((state) => {
      const current = state.runsByParentSessionId[parentSessionId];
      if (!current || current.runId !== runId) return state;
      if (phase === 'idle') {
        const runsByParentSessionId = { ...state.runsByParentSessionId };
        delete runsByParentSessionId[parentSessionId];
        return { runsByParentSessionId };
      }
      if (current.phase === phase) return state;
      return {
        runsByParentSessionId: {
          ...state.runsByParentSessionId,
          [parentSessionId]: { ...current, phase },
        },
      };
    }),

  updateAdvisor: (parentSessionId, runId, index, update) =>
    set((state) => {
      const current = state.runsByParentSessionId[parentSessionId];
      if (!current || current.runId !== runId) return state;
      const position = current.advisors.findIndex((advisor) => advisor.index === index);
      if (position === -1) return state;
      const advisor = current.advisors[position];
      const updated = applyAdvisorUpdate(advisor, update);
      if (updated === advisor) return state;
      const advisors = [...current.advisors];
      advisors[position] = updated;
      return {
        runsByParentSessionId: {
          ...state.runsByParentSessionId,
          [parentSessionId]: { ...current, advisors },
        },
      };
    }),

  finish: (parentSessionId, runId, summary) =>
    set((state) => {
      const current = state.runsByParentSessionId[parentSessionId];
      if (!current || current.runId !== runId) return state;
      const advisors = summary.advisors
        ? applyAdvisorOutcomes(current.advisors, summary.advisors)
        : current.advisors;
      const next: ConsultRunProgress = {
        ...current,
        phase: summary.phase,
        degraded: summary.phase === 'done' && summary.degraded === true,
        advisors,
      };
      if (summary.error) next.error = summary.error;
      else delete next.error;
      return {
        runsByParentSessionId: {
          ...state.runsByParentSessionId,
          [parentSessionId]: next,
        },
      };
    }),

  cancel: (parentSessionId, runId) =>
    set((state) => {
      const current = state.runsByParentSessionId[parentSessionId];
      if (!current || current.runId !== runId) return state;
      if (isTerminalPhase(current.phase)) return state;
      let changed = false;
      const advisors = current.advisors.map((advisor) => {
        if (advisor.status !== 'queued' && advisor.status !== 'running') return advisor;
        changed = true;
        const cancelled: ConsultAdvisorProgress = { ...advisor, status: 'cancelled' };
        return cancelled;
      });
      return {
        runsByParentSessionId: {
          ...state.runsByParentSessionId,
          [parentSessionId]: {
            ...current,
            phase: 'cancelled',
            advisors: changed ? advisors : current.advisors,
          },
        },
      };
    }),

  resetForRuntimeSwitch: () => {
    if (Object.keys(get().runsByParentSessionId).length === 0) return;
    set({ runsByParentSessionId: NO_RUNS });
  },
}));

/** The run of one session, or `undefined` when there is none. */
export const selectConsultRun = (
  state: Pick<ConsultStore, 'runsByParentSessionId'>,
  parentSessionId: string,
): ConsultRunProgress | undefined => state.runsByParentSessionId[parentSessionId];

/** React subscription for one session's run; stable until that run changes. */
export const useConsultRun = (parentSessionId: string): ConsultRunProgress | undefined =>
  useConsultStore((state) => selectConsultRun(state, parentSessionId));

/** True while a run is between start and its terminal phase. */
export const isConsultRunActive = (run: ConsultRunProgress | undefined): boolean =>
  run !== undefined && run.phase !== 'idle' && !isTerminalPhase(run.phase);
