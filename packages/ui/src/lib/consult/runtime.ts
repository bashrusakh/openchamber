import type { Agent, Message, PermissionRuleset, Provider, Session } from '@opencode-ai/sdk/v2';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { opencodeClient } from '@/lib/opencode/client';
import type { OutgoingPart } from '@/components/chat/composer/submit/buildOutgoingMessage';
import * as sessionActions from '@/sync/session-actions';
import { getSyncMessages, registerSessionDirectory } from '@/sync/sync-refs';
import { useConsultPendingHideStore } from '@/stores/useConsultPendingHideStore';
import { useMessageQueueStore } from '@/stores/messageQueueStore';
import type { SessionMetadataRecord } from '@/lib/sessionReviewMetadata';
import { withConsultAdvisorMarker } from '@/lib/consult/metadata';
import {
  waitForConsultAdvisorCompletion,
  type ConsultCompletionDeps,
  type ConsultCompletionOutcome,
  type ConsultMessageRecord,
} from '@/lib/consult/completion';
import { CONSULT_ADVISOR_SYSTEM_PROMPT } from '@/lib/consult/prompts';
import {
  ConsultForkPointError,
  resolveConsultForkPoint,
  validateConsultAdvisors,
  type ConsultAdvisorRejection,
  type ConsultAdvisorSelection,
  type ConsultForkPoint,
  type ConsultModelSurface,
} from '@/lib/consult/routing';

/**
 * Consult Models advisor runtime.
 *
 * `startConsultation` fans the current user message out to hidden read-only
 * forks of the parent session and returns the collected advisor outputs for
 * the synthesis/dispatch stage (WP3.2). This module owns the fork lifecycle
 * only; queue admission and the acting turn stay with the caller.
 *
 * Lifecycle per advisor fork (WP1.3, plan §4):
 *
 * 1. validate every advisor against the real model/agent/variant surface
 *    before any fork (Phase 0 A5: the server fails late or silently, so the
 *    only place to refuse a mismatch is here);
 * 2. resolve the fork point from the parent transcript (HEAD for a settled
 *    parent, the last completed assistant message as a defensive fallback);
 * 3. `forkSession` → register the returned id in the pending-hide registry →
 *    bind the `consult-advisor` marker as the first write after the fork →
 *    register the directory → set the wildcard deny-all permission so the
 *    advisor request has no tool schema at all;
 * 4. send the parent message text and attachments as a headless
 *    `opencodeClient.sendMessage` with the exact provider/model/variant/agent
 *    and the advisor framing as turn-scoped `system`;
 * 5. wait for the trailing completed assistant message (completion.ts);
 * 6. collect partial results, delete every fork best-effort, and return
 *    anonymous advisor blocks plus model provenance.
 *
 * Cancellation and supersession (WP1.4): `cancel(runId)` records the run token
 * first, releases this run's owner-scoped queue admission hold, aborts the
 * forks, deletes them, and sweeps pending-hide entries. Starting a new
 * consultation for the same parent cancels the previous run first and waits
 * for its cleanup before the new run forks anything. Late advisor results are
 * ignored because every application point rechecks the run token and the
 * captured runtime key.
 *
 * The normal settle path deliberately does **not** release the admission hold:
 * the submission that asserted the hold keeps it valid through its own
 * dispatch and owns that release. Releasing here would open a gap between the
 * supervisor finishing its fan-out and the acting turn being sent.
 *
 * Invariants:
 * - one acting agent: advisors never touch the parent session or the UI
 *   stores, and advisor sessions never receive session knowledge (the send
 *   bypasses `useSessionUIStore.sendMessage`/`routeMessage`, which is what
 *   resolves pending session knowledge);
 * - one turn per advisor: no follow-up sends, no recursive consultation;
 * - read-only: wildcard deny-all `session.update({permission})` removes the
 *   tool schema (Phase 0 A3/A4/A9);
 * - no substitution: a rejected selection refuses the start, and a failing
 *   advisor is reported failed with its reason;
 * - late results never apply: every advisor step rechecks the run token and
 *   the captured runtime key;
 * - advisor sends never participate in the shared provider circuit breaker
 *   (WP1.6): every dispatch carries `trackProviderErrors: false`;
 * - the queue admission hold is owner-scoped per run (`consult:<runId>`) and
 *   released on cancellation. A superseded run can therefore never clear the
 *   superseding run's hold, and a held session stays held for every other
 *   owner. The release is per-run idempotent, best-effort, and skipped once
 *   the captured runtime is no longer active, because a hold belongs to the
 *   server that created it.
 */

export const CONSULT_ADVISOR_PERMISSION: PermissionRuleset = [
  { permission: '*', pattern: '*', action: 'deny' },
];

/** Concurrent advisor forks; `sequential` runs one at a time. */
export const CONSULT_PARALLEL_LIMIT = 3;

/** Tail size read for completion; the sent message and its reply are the last records. */
const COMPLETION_READ_LIMIT = 10;

/**
 * The queue-hold owner a consult run asserts. Owner-scoped so a consult never
 * clears another owner's hold (auto-review) and one run never clears a
 * superseding run's hold.
 */
export const consultHoldOwner = (runId: string): string => `consult:${runId}`;

/**
 * Attachment reused from the acting message; mirrors `opencodeClient.sendMessage` file input.
 * No composer attachment id: an OpenCode file part id must start with `prt`, and the acting
 * server path's `toFilePart` sends no id either.
 */
export type ConsultAttachmentInput = {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
};

export type ConsultAdvisorSendParams = {
  id: string;
  providerID: string;
  modelID: string;
  text: string;
  agent: string;
  variant?: string;
  files?: ConsultAttachmentInput[];
  /**
   * The captured context parts (linked PR, file quote, synthetic parts, and
   * their instructions) the acting turn also receives; the advisors must see
   * the same current input. Mutable here to match the client's send contract.
   */
  additionalParts?: OutgoingPart[];
  directory: string;
  system: string;
  runtimeKey: string;
  /**
   * Advisor sends never participate in the shared provider circuit breaker
   * (WP1.6): a run of failing advisors must not open the circuit for the
   * acting turn, and an open circuit must not block advisors. Literal `false`
   * keeps every dispatch on the untracked path.
   */
  trackProviderErrors: false;
};

/** The client operations the runtime performs, injectable for tests. */
export type ConsultRuntimeClient = {
  forkSession: (sessionId: string, messageId: string | undefined, directory: string) => Promise<Session>;
  sendMessage: (params: ConsultAdvisorSendParams) => Promise<string>;
  updateSession: (id: string, patch: { permission: PermissionRuleset }, directory: string) => Promise<Session>;
  /** Read-back path for the effective permission ruleset. */
  getSession: (sessionId: string, directory: string) => Promise<Session>;
  getProvidersForConfig: (
    directory: string,
  ) => Promise<{ providers: readonly Provider[]; default: { [key: string]: string } }>;
  listAgents: (directory: string) => Promise<readonly Agent[]>;
};

/** The canonical session actions the runtime calls, injectable for tests. */
export type ConsultRuntimeSessionActions = {
  patchSessionMetadata: (
    sessionId: string,
    directory: string | null | undefined,
    updater: (metadata: SessionMetadataRecord) => SessionMetadataRecord,
    expectedRuntimeKey?: string,
  ) => Promise<Session>;
  registerSessionDirectory: (sessionId: string, directory: string) => void;
  abortCurrentOperation: (sessionId: string) => Promise<void>;
  deleteSessionInDirectory: (sessionId: string, directory: string, expectedRuntimeKey?: string) => Promise<boolean>;
};

/** The pending-hide registry (`useConsultPendingHideStore`) as the runtime uses it. */
export type ConsultPendingHideRegistry = {
  register: (sessionId: string) => void;
  release: (sessionId: string) => void;
};

/**
 * Releases one owner's queue admission hold for a parent session. The runtime
 * calls it on cancellation; the submission that asserted the hold owns the
 * normal settle/dispatch release, because the hold must stay valid until that
 * dispatch. The hook must be idempotent and must not throw into the settle
 * path (a rejected promise is swallowed).
 */
export type ConsultAdmissionHoldRelease = (sessionId: string, owner: string) => void | Promise<void>;

/**
 * Active-run registry shared with the stale-fork GC (`gc.ts`). A run is
 * registered for its whole lifetime, so a fork whose `consultRunID` is still
 * active is never swept.
 */
export type ConsultRunRegistry = {
  register: (runId: string) => void;
  unregister: (runId: string) => void;
  isActive: (runId: string) => boolean;
};

export const createConsultRunRegistry = (): ConsultRunRegistry => {
  const ids = new Set<string>();
  return {
    register: (runId) => {
      ids.add(runId);
    },
    unregister: (runId) => {
      ids.delete(runId);
    },
    isActive: (runId) => ids.has(runId),
  };
};

/** The live runtime instance's registry; the GC consults it through `isConsultRunActive`. */
const sharedRunRegistry = createConsultRunRegistry();

/** True while a consultation run is live on this client. */
export const isConsultRunActive = (runId: string): boolean => sharedRunRegistry.isActive(runId);

export type ConsultRuntimeDeps = {
  client: ConsultRuntimeClient;
  session: ConsultRuntimeSessionActions;
  pendingHide: ConsultPendingHideRegistry;
  /** Current runtime key; a change abandons the run. */
  runtimeKey: () => string;
  /** Parent transcript tail used for the fork-point decision. */
  readParentMessages: (sessionId: string, directory: string) => readonly Message[];
  /** Fork transcript tail used for completion observation. */
  readForkMessages: (sessionId: string, directory: string) => Promise<readonly ConsultMessageRecord[]>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  createRunId?: () => string;
  /** Releases the queue admission hold on cancel/settle for the parent's owning run (WP1.4). */
  releaseAdmissionHold?: ConsultAdmissionHoldRelease;
  /** Active-run registry shared with the GC; defaults to a per-runtime instance. */
  runRegistry?: ConsultRunRegistry;
};

export type ConsultationRefusalCode =
  | 'no-advisors'
  | 'runtime-changed'
  | 'surface-unavailable'
  | 'invalid-advisor'
  | 'no-settled-context';

/**
 * A start-time refusal: no fork was created, so the caller can restore the
 * composer and show the reason. Never a silent fallback to another model.
 */
export class ConsultationRefusedError extends Error {
  readonly code: ConsultationRefusalCode;
  readonly rejections: readonly ConsultAdvisorRejection[];

  constructor(code: ConsultationRefusalCode, message: string, rejections: readonly ConsultAdvisorRejection[] = []) {
    super(message);
    this.name = 'ConsultationRefusedError';
    this.code = code;
    this.rejections = rejections;
  }
}

export type ConsultationMode = 'parallel' | 'sequential';

export type ConsultAdvisorStatus = 'ok' | 'failed' | 'timeout' | 'empty' | 'cancelled';

/** Per-advisor provenance for the receipt; not part of the synthesis text. */
export type ConsultAdvisorProvenance = {
  index: number;
  providerID: string;
  modelID: string;
  variant?: string;
  agent: string;
  status: ConsultAdvisorStatus;
  durationMs: number;
  reason?: string;
};

/** One usable advisor output, stripped of its model identity for synthesis. */
export type ConsultAdvisorBlock = {
  text: string;
};

export type ConsultationStatus = 'ok' | 'partial' | 'degraded' | 'cancelled';

export type ConsultationResult = {
  runId: string;
  parentSessionId: string;
  mode: ConsultationMode;
  /** `degraded` means no usable output; `cancelled` means the caller must not dispatch. */
  status: ConsultationStatus;
  advisors: readonly ConsultAdvisorProvenance[];
  /** Anonymous successful outputs, in advisor order; empty when cancelled. */
  blocks: readonly ConsultAdvisorBlock[];
  durationMs: number;
};

export type ConsultationHandle = {
  runId: string;
  result: Promise<ConsultationResult>;
};

/**
 * Live per-advisor progress emitted during the fan-out: `started` when the
 * advisor's send begins, `settled` when it reaches a terminal status. The
 * panel drives its rows from these; the run store guards updates by runId.
 */
export type ConsultAdvisorEvent = {
  index: number;
  phase: 'started' | 'settled';
  /** Terminal status on `settled`; absent on `started`. */
  status?: ConsultAdvisorStatus;
  durationMs?: number;
  reason?: string;
};

export type StartConsultationInput = {
  parentSessionId: string;
  directory: string;
  /** Runtime key captured by the caller; a change abandons the run. */
  expectedRuntimeKey?: string;
  advisors: readonly ConsultAdvisorSelection[];
  /** The acting user message the advisors must answer. */
  messageText: string;
  attachments?: readonly ConsultAttachmentInput[];
  /** Captured context parts accompanying the message (same as the acting turn). */
  additionalParts?: readonly OutgoingPart[];
  mode?: ConsultationMode;
  /** Per-advisor deadline, default 120 s. */
  timeoutMs?: number;
  /** Caller-owned admission assertion (WP3.2 queue head + authoritative idle). */
  assertAdmissible?: () => void | Promise<void>;
  /** Overrides the generated run id (tests). */
  runId?: string;
  /**
   * Live per-advisor progress for the panel. Called only while this run is
   * still live (the loop's own token check guards every emission); never
   * throws into the advisor path.
   */
  onAdvisor?: (event: ConsultAdvisorEvent) => void;
};

export type ConsultRuntime = {
  startConsultation: (input: StartConsultationInput) => ConsultationHandle;
  /** Idempotent; returns once cancellation is recorded and forks are cleaned best-effort. */
  cancel: (runId: string) => Promise<void>;
  /**
   * Advisor-surface prevalidation: the same refusals `startConsultation`
   * raises before its first fork (runtime key, advisor list, surface), without
   * creating a run or a fork and without resolving the settled-context fork
   * point. Exported through the runtime so the submission can prevalidate
   * before queue admission.
   */
  prevalidateConsultation: (input: StartConsultationInput) => Promise<void>;
};

type AdvisorState = {
  index: number;
  selection: ConsultAdvisorSelection;
  status: ConsultAdvisorStatus | 'pending';
  text: string | null;
  reason: string | null;
  durationMs: number;
};

type ActiveRun = {
  runId: string;
  parentSessionId: string;
  runtimeKey: string;
  cancelled: boolean;
  /** Recorded once; a second cancel or a settle awaits/observes the same cleanup. */
  cancellation: Promise<void> | null;
  /** Previous same-parent run's cleanup; awaited before this run forks anything. */
  supersededCleanup: Promise<void> | null;
  holdReleased: boolean;
  startedAt: number;
  advisors: AdvisorState[];
  forkIds: Set<string>;
  /** Pending-hide entries this run registered and has not released yet. */
  hiddenForkIds: Set<string>;
  forkDirectoryById: Map<string, string>;
};

const defaultCreateRunId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `consult-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

export const createConsultRuntime = (deps: ConsultRuntimeDeps): ConsultRuntime => {
  const activeRuns = new Map<string, ActiveRun>();
  /** One live run per parent: a new start supersedes the previous one. */
  const activeRunByParent = new Map<string, string>();
  const runRegistry = deps.runRegistry ?? createConsultRunRegistry();
  const createRunId = deps.createRunId ?? defaultCreateRunId;
  const completionDeps: ConsultCompletionDeps = {
    readMessages: deps.readForkMessages,
    now: deps.now,
    sleep: deps.sleep,
  };

  const isAbandoned = (run: ActiveRun): boolean => {
    if (run.cancelled) return true;
    if (deps.runtimeKey() !== run.runtimeKey) {
      run.cancelled = true;
      return true;
    }
    return false;
  };

  /**
   * Release this run's owner-scoped queue admission hold once. Best-effort by
   * design: a failing release must never affect the run result or the settle
   * path, and a hold belongs to the runtime that created it, so a run whose
   * runtime is gone leaves the hold to its server-side expiry instead of
   * touching a same-id session on the new runtime.
   *
   * Owner scoping is what makes this safe on a superseded run: releasing
   * `consult:<runId>` can never clear the superseding run's own hold, and an
   * owner-less auto-review hold is untouched. The normal settle path does not
   * call this — the submission keeps the hold valid through its dispatch and
   * releases it there.
   */
  const releaseHold = (run: ActiveRun): void => {
    if (run.holdReleased) return;
    if (deps.runtimeKey() !== run.runtimeKey) return;
    run.holdReleased = true;
    if (!deps.releaseAdmissionHold) return;
    try {
      void Promise.resolve(deps.releaseAdmissionHold(run.parentSessionId, consultHoldOwner(run.runId))).catch(() => undefined);
    } catch {
      // Best-effort: the hold expires server-side.
    }
  };

  const registerForkPendingHide = (run: ActiveRun, forkId: string): void => {
    run.hiddenForkIds.add(forkId);
    // The server can publish the fork before its marker lands; the registry
    // hides it until the marker is readable.
    deps.pendingHide.register(forkId);
  };

  const releaseForkPendingHide = (run: ActiveRun, forkId: string): void => {
    if (!run.hiddenForkIds.delete(forkId)) return;
    deps.pendingHide.release(forkId);
  };

  /** Drop every pending-hide entry this run registered, including forks whose marker never landed. */
  const sweepPendingHides = (run: ActiveRun): void => {
    for (const forkId of [...run.hiddenForkIds]) releaseForkPendingHide(run, forkId);
  };

  /** Delete a fork best-effort and drop its pending-hide entry. Idempotent per fork. */
  const discardFork = async (run: ActiveRun, forkId: string): Promise<void> => {
    if (run.forkIds.delete(forkId)) {
      const directory = run.forkDirectoryById.get(forkId);
      try {
        if (directory) await deps.session.deleteSessionInDirectory(forkId, directory, run.runtimeKey);
      } catch {
        // Best-effort: the marker keeps the fork hidden and the consult GC (WP1.4) collects it.
      }
    }
    releaseForkPendingHide(run, forkId);
  };

  const cleanupRun = async (run: ActiveRun): Promise<void> => {
    const forkIds = [...run.forkIds];
    await Promise.all(forkIds.map((forkId) => discardFork(run, forkId)));
    sweepPendingHides(run);
  };

  /**
   * Record cancellation and run the abort/delete cleanup once per run.
   *
   * The token is set synchronously before any await, so advisor work that
   * resumes after this point observes the abandonment and drops its result.
   * The returned promise resolves when the known forks have been aborted and
   * deleted best-effort; a second call returns the same promise.
   */
  const beginCancellation = (run: ActiveRun): Promise<void> => {
    if (run.cancellation) return run.cancellation;
    run.cancelled = true;
    // Release the hold before the abort/delete round-trips so the queue can
    // proceed even if a fork cleanup call is slow.
    releaseHold(run);
    run.cancellation = (async () => {
      const forkIds = [...run.forkIds];
      await Promise.all(forkIds.map(async (forkId) => {
        try {
          await deps.session.abortCurrentOperation(forkId);
        } catch {
          // Abort is best-effort; the delete below and the run token still stop the work.
        }
      }));
      await Promise.all(forkIds.map((forkId) => discardFork(run, forkId)));
      sweepPendingHides(run);
    })();
    return run.cancellation;
  };

  const finishAdvisor = (
    advisor: AdvisorState,
    status: ConsultAdvisorStatus,
    text: string | null,
    reason: string | null,
    startedAt: number,
  ): void => {
    advisor.status = status;
    advisor.text = text;
    advisor.reason = reason;
    advisor.durationMs = Math.max(0, deps.now() - startedAt);
  };

  const applyCompletionOutcome = (
    advisor: AdvisorState,
    outcome: ConsultCompletionOutcome,
    startedAt: number,
  ): void => {
    switch (outcome.status) {
      case 'completed':
        finishAdvisor(advisor, 'ok', outcome.text, null, startedAt);
        break;
      case 'empty':
        finishAdvisor(advisor, 'empty', null, outcome.reason, startedAt);
        break;
      case 'error':
        finishAdvisor(advisor, 'failed', null, outcome.reason, startedAt);
        break;
      case 'timeout':
        finishAdvisor(advisor, 'timeout', null, outcome.reason, startedAt);
        break;
      case 'cancelled':
        finishAdvisor(advisor, 'cancelled', null, null, startedAt);
        break;
    }
  };

  const emitAdvisor = (
    input: StartConsultationInput,
    event: ConsultAdvisorEvent,
  ): void => {
    if (!input.onAdvisor) return;
    try {
      input.onAdvisor(event);
    } catch {
      // Progress reporting never throws into the advisor path.
    }
  };

  /**
   * F3 fail-closed: the deny-all ruleset is what removes the advisor's tool
   * schema, so the write is verified by read-back before anything is sent.
   * The effective ruleset must carry the exact wildcard deny rule; an absent
   * ruleset is refetched once, and any failure to prove the rule fails the
   * advisor instead of sending unverified.
   */
  const hasDenyAllPermission = (permission: PermissionRuleset | undefined): boolean =>
    Array.isArray(permission) && permission.some((rule) => (
      rule.permission === '*' && rule.pattern === '*' && rule.action === 'deny'
    ));

  const verifyAdvisorPermission = async (
    forkId: string,
    directory: string,
    written: Session,
  ): Promise<boolean> => {
    if (hasDenyAllPermission(written.permission)) return true;
    try {
      const refetched = await deps.client.getSession(forkId, directory);
      return hasDenyAllPermission(refetched.permission);
    } catch {
      // A failed read-back cannot prove the lock: fail closed.
      return false;
    }
  };

  const runAdvisor = async (
    run: ActiveRun,
    input: StartConsultationInput,
    forkPoint: ConsultForkPoint,
    advisor: AdvisorState,
  ): Promise<void> => {
    const startedAt = deps.now();
    if (isAbandoned(run)) {
      finishAdvisor(advisor, 'cancelled', null, null, startedAt);
      return;
    }
    emitAdvisor(input, { index: advisor.index, phase: 'started' });

    let fork: Session;
    try {
      fork = await deps.client.forkSession(
        input.parentSessionId,
        forkPoint.kind === 'message' ? forkPoint.messageID : undefined,
        input.directory,
      );
    } catch (error) {
      if (isAbandoned(run)) {
        finishAdvisor(advisor, 'cancelled', null, null, startedAt);
        return;
      }
      // The rejection is ambiguous: the server may have created the clone
      // before the response was lost, and such a clone has no marker, no
      // pending-hide entry, and no GC eligibility. Nothing here can identify
      // it positively — a session id that merely appeared after a listing
      // could belong to the user, another client, or another run's fork —
      // and hiding, marking, or deleting the wrong session is worse than
      // leaving the clone. Accepted bound: a possible clone stays exactly as
      // it is (visible until the user deletes it); the advisor is failed.
      const reason = error instanceof Error ? error.message : String(error);
      finishAdvisor(advisor, 'failed', null, reason, startedAt);
      emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'failed', durationMs: advisor.durationMs, reason });
      return;
    }

    const directory = fork.directory.trim().length > 0 ? fork.directory : input.directory;
    run.forkIds.add(fork.id);
    run.forkDirectoryById.set(fork.id, directory);
    registerForkPendingHide(run, fork.id);

    if (isAbandoned(run)) {
      await discardFork(run, fork.id);
      finishAdvisor(advisor, 'cancelled', null, null, startedAt);
      emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
      return;
    }

    try {
      await deps.session.patchSessionMetadata(
        fork.id,
        directory,
        (metadata) => withConsultAdvisorMarker(metadata, {
          originalSessionID: input.parentSessionId,
          consultRunID: run.runId,
          advisorIndex: advisor.index,
        }),
        run.runtimeKey,
      );
      // The marker is persisted and mirrored into the live stores, so the
      // registry no longer needs to hide this fork.
      releaseForkPendingHide(run, fork.id);
      deps.session.registerSessionDirectory(fork.id, directory);
      const written = await deps.client.updateSession(fork.id, { permission: CONSULT_ADVISOR_PERMISSION }, directory);
      // F3 fail-closed: verify the deny-all lock by read-back before any send.
      const permissionVerified = await verifyAdvisorPermission(fork.id, directory, written);
      if (!permissionVerified) {
        releaseForkPendingHide(run, fork.id);
        await discardFork(run, fork.id);
        if (isAbandoned(run)) {
          finishAdvisor(advisor, 'cancelled', null, null, startedAt);
          emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
          return;
        }
        const reason = 'permission-verification-failed';
        finishAdvisor(advisor, 'failed', null, reason, startedAt);
        emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'failed', durationMs: advisor.durationMs, reason });
        return;
      }
    } catch (error) {
      const reason = `Advisor setup failed: ${error instanceof Error ? error.message : String(error)}`;
      releaseForkPendingHide(run, fork.id);
      await discardFork(run, fork.id);
      if (isAbandoned(run)) {
        finishAdvisor(advisor, 'cancelled', null, null, startedAt);
        emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
        return;
      }
      finishAdvisor(advisor, 'failed', null, reason, startedAt);
      emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'failed', durationMs: advisor.durationMs, reason });
      return;
    }

    if (isAbandoned(run)) {
      await discardFork(run, fork.id);
      finishAdvisor(advisor, 'cancelled', null, null, startedAt);
      emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
      return;
    }

    try {
      const params: ConsultAdvisorSendParams = {
        id: fork.id,
        providerID: advisor.selection.providerID,
        modelID: advisor.selection.modelID,
        text: input.messageText,
        agent: advisor.selection.agent,
        files: [...(input.attachments ?? [])],
        directory,
        system: CONSULT_ADVISOR_SYSTEM_PROMPT,
        runtimeKey: run.runtimeKey,
        trackProviderErrors: false,
      };
      const variant = advisor.selection.variant?.trim();
      if (variant) params.variant = variant;
      if (input.additionalParts && input.additionalParts.length > 0) {
        params.additionalParts = [...input.additionalParts];
      }

      const userMessageID = await deps.client.sendMessage(params);
      const outcome = await waitForConsultAdvisorCompletion(completionDeps, {
        sessionID: fork.id,
        directory,
        userMessageID,
        timeoutMs: input.timeoutMs,
        isCancelled: () => isAbandoned(run),
      });
      if (isAbandoned(run)) {
        finishAdvisor(advisor, 'cancelled', null, null, startedAt);
        emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
        return;
      }
      applyCompletionOutcome(advisor, outcome, startedAt);
      emitAdvisor(input, {
        index: advisor.index,
        phase: 'settled',
        status: advisor.status === 'pending' ? 'cancelled' : advisor.status,
        durationMs: advisor.durationMs,
        reason: advisor.reason ?? undefined,
      });
    } catch (error) {
      if (isAbandoned(run)) {
        finishAdvisor(advisor, 'cancelled', null, null, startedAt);
        emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'cancelled', durationMs: advisor.durationMs });
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      finishAdvisor(advisor, 'failed', null, reason, startedAt);
      emitAdvisor(input, { index: advisor.index, phase: 'settled', status: 'failed', durationMs: advisor.durationMs, reason });
    }
  };

  const runAdvisors = async (
    run: ActiveRun,
    input: StartConsultationInput,
    forkPoint: ConsultForkPoint,
  ): Promise<void> => {
    const limit = (input.mode ?? 'parallel') === 'sequential' ? 1 : CONSULT_PARALLEL_LIMIT;
    let nextIndex = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= run.advisors.length) return;
        await runAdvisor(run, input, forkPoint, run.advisors[index]);
      }
    };
    const workers = Array.from({ length: Math.min(limit, run.advisors.length) }, () => worker());
    await Promise.all(workers);
  };

  const buildResult = (
    run: ActiveRun,
    input: StartConsultationInput,
    mode: ConsultationMode,
  ): ConsultationResult => {
    const advisors = run.advisors.map((advisor): ConsultAdvisorProvenance => {
      const provenance: ConsultAdvisorProvenance = {
        index: advisor.index,
        providerID: advisor.selection.providerID,
        modelID: advisor.selection.modelID,
        agent: advisor.selection.agent,
        status: advisor.status === 'pending' ? 'cancelled' : advisor.status,
        durationMs: advisor.durationMs,
      };
      const variant = advisor.selection.variant?.trim();
      if (variant) provenance.variant = variant;
      if (advisor.reason) provenance.reason = advisor.reason;
      return provenance;
    });

    const blocks: ConsultAdvisorBlock[] = [];
    for (const advisor of run.advisors) {
      if (advisor.status === 'ok' && advisor.text !== null) blocks.push({ text: advisor.text });
    }

    const successful = blocks.length;
    const status: ConsultationStatus = run.cancelled
      ? 'cancelled'
      : successful === 0
        ? 'degraded'
        : successful === run.advisors.length
          ? 'ok'
          : 'partial';

    return {
      runId: run.runId,
      parentSessionId: input.parentSessionId,
      mode,
      status,
      advisors,
      blocks: run.cancelled ? [] : blocks,
      durationMs: Math.max(0, deps.now() - run.startedAt),
    };
  };

  /**
   * Pre-enqueue prevalidation without creating anything, limited to the
   * advisor surface: the runtime-key check, the advisor-list check, and the
   * model/agent surface load with `validateConsultAdvisors` — the same checks
   * `startConsultation` performs first, in the same order, throwing the same
   * `ConsultationRefusedError` codes. The settled-context fork point is
   * deliberately NOT resolved here: a parent with no completed assistant
   * message may become settled while the item waits for its claim, and the
   * post-claim refusal path (item removed, hold released, composer restored)
   * is the contract for a still-unsettled parent.
   */
  const prevalidateConsultation = async (input: StartConsultationInput): Promise<void> => {
    const expectedRuntimeKey = input.expectedRuntimeKey;
    if (expectedRuntimeKey !== undefined && deps.runtimeKey() !== expectedRuntimeKey) {
      throw new ConsultationRefusedError('runtime-changed', 'The runtime changed before the consultation started');
    }
    if (input.advisors.length === 0) {
      throw new ConsultationRefusedError('no-advisors', 'Select at least one advisor model');
    }

    let surface: ConsultModelSurface;
    try {
      const [catalog, agents] = await Promise.all([
        deps.client.getProvidersForConfig(input.directory),
        deps.client.listAgents(input.directory),
      ]);
      surface = { providers: catalog.providers, agents };
    } catch (error) {
      throw new ConsultationRefusedError(
        'surface-unavailable',
        `Could not load the model surface: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const validation = validateConsultAdvisors(input.advisors, surface);
    if (!validation.ok) {
      throw new ConsultationRefusedError(
        'invalid-advisor',
        'The advisor selection is not available on this runtime',
        validation.rejections,
      );
    }
  };

  /** The settled-context fork point, resolved inside a start (never pre-enqueue). */
  const resolveStartForkPoint = (input: StartConsultationInput): ConsultForkPoint => {
    try {
      return resolveConsultForkPoint(deps.readParentMessages(input.parentSessionId, input.directory));
    } catch (error) {
      if (error instanceof ConsultForkPointError) {
        throw new ConsultationRefusedError('no-settled-context', error.message);
      }
      throw error;
    }
  };

  const executeRun = async (run: ActiveRun, input: StartConsultationInput): Promise<ConsultationResult> => {
    const mode = input.mode ?? 'parallel';
    try {
      // A new run for the same parent supersedes the previous one: its
      // cancellation is already recorded, and its forks are cleaned before
      // this run creates anything.
      if (run.supersededCleanup) await run.supersededCleanup;
      await prevalidateConsultation(input);
      // The fork point is a start-time concern, resolved after the claim (and
      // after admission): a parent that is still running may never settle, in
      // which case the start refuses and the submission returns the message.
      const forkPoint = resolveStartForkPoint(input);
      if (input.assertAdmissible) await input.assertAdmissible();
      if (isAbandoned(run)) return buildResult(run, input, mode);

      await runAdvisors(run, input, forkPoint);
      return buildResult(run, input, mode);
    } finally {
      // Clean every fork and pending-hide entry, including entries whose marker
      // never landed. The admission hold is deliberately not released here:
      // the submission that asserted it keeps it valid through its dispatch.
      await cleanupRun(run);
    }
  };

  /**
   * Cancel a previous run for the same parent and return its cleanup. The
   * cancellation token is recorded synchronously, so the previous run cannot
   * apply a late result while this one is being set up. The new run is
   * registered as the parent's owner first, so the superseded run's hold
   * release cannot clear the session-level hold the new run relies on.
   */
  const startConsultation = (input: StartConsultationInput): ConsultationHandle => {
    const runId = input.runId ?? createRunId();
    const previousRunId = activeRunByParent.get(input.parentSessionId);
    const run: ActiveRun = {
      runId,
      parentSessionId: input.parentSessionId,
      runtimeKey: input.expectedRuntimeKey ?? deps.runtimeKey(),
      cancelled: false,
      cancellation: null,
      supersededCleanup: null,
      holdReleased: false,
      startedAt: deps.now(),
      advisors: input.advisors.map((selection, index) => ({
        index,
        selection,
        status: 'pending',
        text: null,
        reason: null,
        durationMs: 0,
      })),
      forkIds: new Set(),
      hiddenForkIds: new Set(),
      forkDirectoryById: new Map(),
    };
    // Register the new run before cancelling the previous one, so only one run
    // per parent owns the session-level admission hold at any point.
    activeRuns.set(runId, run);
    activeRunByParent.set(input.parentSessionId, runId);
    if (previousRunId && previousRunId !== runId) {
      const previous = activeRuns.get(previousRunId);
      run.supersededCleanup = previous ? beginCancellation(previous) : null;
    }
    runRegistry.register(runId);
    const result = executeRun(run, input).finally(() => {
      activeRuns.delete(runId);
      if (activeRunByParent.get(input.parentSessionId) === runId) {
        activeRunByParent.delete(input.parentSessionId);
      }
      runRegistry.unregister(runId);
    });
    return { runId, result };
  };

  const cancel = async (runId: string): Promise<void> => {
    const run = activeRuns.get(runId);
    if (!run) return;
    await beginCancellation(run);
  };

  return { startConsultation, cancel, prevalidateConsultation };
};

const defaultDeps = (): ConsultRuntimeDeps => ({
  client: {
    forkSession: (sessionId, messageId, directory) => opencodeClient.forkSession(sessionId, messageId, directory),
    sendMessage: (params) => opencodeClient.sendMessage(params),
    updateSession: (id, patch, directory) => opencodeClient.updateSession(id, patch, directory),
    getSession: (sessionId, directory) => opencodeClient.getSession(sessionId, directory),
    getProvidersForConfig: (directory) => opencodeClient.getProvidersForConfig(directory),
    listAgents: (directory) => opencodeClient.listAgents(directory),
  },
  session: {
    patchSessionMetadata: sessionActions.patchSessionMetadata,
    registerSessionDirectory,
    abortCurrentOperation: sessionActions.abortCurrentOperation,
    deleteSessionInDirectory: sessionActions.deleteSessionInDirectory,
  },
  pendingHide: {
    register: (sessionId) => useConsultPendingHideStore.getState().register(sessionId),
    release: (sessionId) => useConsultPendingHideStore.getState().release(sessionId),
  },
  runtimeKey: getRuntimeKey,
  readParentMessages: (sessionId, directory) => getSyncMessages(sessionId, directory),
  readForkMessages: (sessionId, directory) =>
    opencodeClient.getSessionMessages(sessionId, COMPLETION_READ_LIMIT, directory),
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  releaseAdmissionHold: (sessionId, owner) =>
    useMessageQueueStore.getState().setServerHold(sessionId, false, owner),
  runRegistry: sharedRunRegistry,
});

/** Shared runtime instance wired to the live client, session actions, and stores. */
export const consultRuntime: ConsultRuntime = createConsultRuntime(defaultDeps());
