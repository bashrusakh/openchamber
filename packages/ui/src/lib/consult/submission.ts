import { resolveQueuedSessionStatusType } from '@/hooks/useQueuedMessageAutoSend';
import { getRuntimeKey } from '@/lib/runtime-switch';
import { queuedContextToParts } from '@/components/chat/composer/submit/buildOutgoingMessage';
import { CONSULT_BACKEND_PROTOCOL_VERSION, CONSULT_MIN_OPENCODE_VERSION, resolveConsultLiveCapability } from '@/lib/consult/capability';
import {
  createMessageQueueTarget,
  useMessageQueueStore,
  type ConsultDispatchOutcome,
  type MessageQueueTarget,
  type QueuedContextPart,
  type QueuedMessage,
  type QueuedMessageSendConfig,
} from '@/stores/messageQueueStore';
import {
  selectConsultRun,
  useConsultStore,
  type ConsultAdvisorOutcome,
  type ConsultRunFinish,
  type ConsultRunMode,
  type ConsultRunPhase,
  type ConsultRunStartInput,
} from '@/stores/useConsultStore';
import { useAutoReviewStore } from '@/stores/useAutoReviewStore';
import type { AttachedFile } from '@/stores/types/sessionTypes';
import {
  ConsultationRefusedError,
  consultHoldOwner,
  consultRuntime,
  type ConsultationHandle,
  type ConsultationRefusalCode,
  type ConsultationResult,
  type ConsultAdvisorProvenance,
  type ConsultAttachmentInput,
  type StartConsultationInput,
} from '@/lib/consult/runtime';
import type { ConsultAdvisorRejection, ConsultAdvisorSelection } from '@/lib/consult/routing';
import {
  buildConsultReceipt,
  buildConsultSynthesisSystem,
  toConsultReceiptMetadata,
  type ConsultReceipt,
} from '@/lib/consult/synthesis';

/**
 * Consult Models submission (WP3.2): queue admission, the advisor fan-out, and
 * the acting dispatch in the parent.
 *
 * The consult message is never sent raw. The session queue is held (for this
 * run's own owner) *before* the message is enqueued, so the server's dispatch
 * quiet timer can never race the hold round trip; a heartbeat re-asserts the
 * hold every `CONSULT_HOLD_REASSERT_MS` so the server's finite TTL cannot
 * lapse during a long admission wait or fan-out (the `useMessageQueueHoldSync`
 * precedent). Hold operations are serialized per run: every re-assert chains
 * behind the previous one, and every terminal path marks the run inactive,
 * awaits the in-flight hold operation, and issues the release last, so a stale
 * re-assert can never land after the release and resurrect the hold. The
 * submission then waits until its item is the queue head and the session is
 * authoritatively idle (the same `resolveQueuedSessionStatusType` semantics
 * the queue gate uses). Only then is the item claimed, the advisor runtime
 * started, and the original message dispatched in the parent through the
 * consult item's own dispatch route with the turn-scoped synthesis `system`
 * (stored by OpenCode on the acting user message, active for that turn only)
 * and the bounded receipt as `textPartMetadata`.
 *
 * Because the call is never made through the queue's delivery path, the acting
 * send is the ordinary store send: it resolves pending session knowledge,
 * records the message-sent notification, and delivers the captured agent
 * mention and attachments. Nothing from the queue's delivery-time behavior is
 * lost, and nothing is delivered twice.
 *
 * A consult and an auto-review loop never share the parent: auto-review drives
 * the session through the queue only, so a consult submitted while that loop
 * runs is refused before anything is queued or held, and a loop starting during
 * the admission wait aborts the consult the same way a cancel does.
 *
 * Queue-item states on the non-dispatch paths (F2: a consult never silently
 * degrades to a normal send):
 *
 * - prevalidation runs BEFORE the hold and the enqueue: an ordinary start
 *   refusal (advisor surface, settled context) happens while nothing is
 *   queued and nothing is held, so the caller restores the composer from its
 *   own captured payload and nothing is sent;
 * - cancel before admission removes the item and releases the hold; the caller
 *   restores the composer from its own captured payload and nothing is sent;
 * - the item leaving the queue without this submission claiming and
 *   dispatching it (another client removed it, for example) is
 *   `delivered-raw`: a consult item is never delivered as a normal send, so
 *   the caller must not restore the composer and must not re-send;
 * - a refusal or failure AFTER the claim removes the consult item and releases
 *   the hold — the message is never re-queued for a normal delivery;
 *   `queueItemRestored` stays `false` and the caller restores the composer;
 * - only a degraded consultation after a real start still dispatches alone
 *   (through the consult item's own dispatch route, carrying the degraded
 *   notice); a cancel mid-consult also removes the claimed item;
 * - a runtime change at any point stops the submission without touching the
 *   queue or the hold: both belong to the runtime that created them, and
 *   session ids are not unique across runtimes;
 * - auto-review taking over the parent while the consult waits for admission
 *   follows the cancel path: the item is removed, the hold is released, and
 *   the composer gets its payload back; a consult submitted while
 *   auto-review already runs is refused with `auto-review-active` before
 *   anything is queued or held.
 *
 * The honest hole (plan section 6, D5): if the UI disappears mid-consult, the
 * heartbeat dies with it and the hold expires; the consult item stays queued
 * (unclaimed, kind kept) and is never delivered as a normal send. The module
 * detects the item leaving the queue without this run (`delivered-raw`)
 * instead of reporting a cancel that would restore the composer and duplicate
 * the send; a stranded item is recovered by removal or a fresh consultation.
 *
 * The module is dependency-injected (`createConsultSubmission`) so every
 * branch - hold acquisition order, heartbeat, head wait, idle wait, claim,
 * payload, dispatch, cancel, partial, degraded, refusal, runtime change, hold
 * idempotence, delivered-raw, auto-review exclusion, prevalidation - is
 * testable with an injected queue, run store, runtime, clock, heartbeat
 * scheduler, auto-review predicate, and acting-send function.
 */

/** How often admission (queue head + authoritatively idle) is re-checked. */
export const CONSULT_ADMISSION_POLL_MS = 500;

/**
 * How often the admission hold is re-asserted. The server's hold TTL default
 * is five minutes, so a two-minute beat keeps the hold continuously valid
 * through a slow enqueue, a long admission wait, and a long fan-out.
 */
export const CONSULT_HOLD_REASSERT_MS = 2 * 60 * 1000;

const RUNTIME_CHANGED_MESSAGE = 'The runtime changed before the consultation was dispatched.';
const DELIVERED_RAW_MESSAGE =
  'The queued consult message left the queue before this consultation could dispatch it.';
const AUTO_REVIEW_ACTIVE_MESSAGE =
  'A consultation cannot start while the automatic review loop is running for this session.';

/**
 * The default refusal for an unverified live capability. The reason decides
 * the diagnosis: a backend whose consult queue protocol is absent or too old
 * needs an OpenChamber backend update, so naming the OpenCode version floor
 * there would misdiagnose a passing OpenCode server.
 */
const capabilityRefusalMessage = (reason: string): string => {
  if (reason === 'protocol-missing') {
    return 'The connected OpenChamber backend does not support the consult queue protocol; update the backend to use Consult Models.';
  }
  if (reason === 'protocol-unsupported') {
    return `The connected OpenChamber backend's consult protocol is older than the required version ${CONSULT_BACKEND_PROTOCOL_VERSION}; update the backend to use Consult Models.`;
  }
  return `Consult Models needs OpenCode ${CONSULT_MIN_OPENCODE_VERSION} or newer; the connected server could not be verified (${reason}).`;
};

const defaultScheduleHoldReassert = (callback: () => void, intervalMs: number): (() => void) => {
  const timer = setInterval(callback, intervalMs);
  return () => clearInterval(timer);
};

/** The live status the admission gate honors; mirrors the queue's own gate. */
export type ConsultSessionStatus = 'idle' | 'busy' | 'retry';

/** The acting send configuration captured with the consult message. */
export type ConsultSubmissionSendConfig = {
  providerID: string;
  modelID: string;
  agent?: string;
  variant?: string;
};

/** The message exactly as the composer queue captures it. */
export type ConsultSubmissionMessage = {
  /** What the user typed, kept for display and editing. */
  content: string;
  /** What is delivered (agent mention stripped); defaults to `content`. */
  text?: string;
  agentMentionName?: string;
  attachments?: AttachedFile[];
  context?: QueuedContextPart[];
};

export type SubmitConsultMessageInput = {
  parentSessionId: string;
  directory: string;
  /** Runtime captured when the consult action was submitted. */
  runtimeKey: string;
  message: ConsultSubmissionMessage;
  /** The acting model/agent/variant; the advisors never become the acting turn. */
  sendConfig: ConsultSubmissionSendConfig;
  /** Exact advisor selections; validated by the runtime before any fork. */
  advisors: readonly ConsultAdvisorSelection[];
  mode: ConsultRunMode;
  /** Per-advisor deadline in milliseconds. */
  timeoutMs: number;
};

/**
 * The outcome of one submission. `dispatched` is the only state in which the
 * acting turn was sent. `queueItemRestored` is set when the taken message was
 * put back in the queue (or left queued un-taken), which means the message
 * will still be delivered normally and the caller must not also restore the
 * composer.
 */
export type ConsultSubmissionResult =
  | {
    status: 'dispatched';
    runId: string;
    receipt: ConsultReceipt;
    consultation: ConsultationResult;
  }
  | {
    status: 'cancelled';
    runId: string;
    consultation?: ConsultationResult;
  }
  | {
    status: 'refused';
    runId: string;
    /**
     * An advisor-runtime refusal code, or `auto-review-active` for the
     * admission-time refusal raised by this module.
     */
    code: ConsultationRefusalCode | 'auto-review-active' | 'capability-unavailable';
    error: string;
    rejections: readonly ConsultAdvisorRejection[];
    queueItemRestored: boolean;
  }
  | {
    status: 'failed';
    runId: string;
    error: string;
    queueItemRestored: boolean;
    consultation?: ConsultationResult;
    /**
     * The dispatch outcome is unconfirmed (an in-flight send, an
     * indeterminate failure, or a transport error): the composer must not
     * restore the capture because the message may already be on its way.
     */
    uncertain?: boolean;
  }
  | {
    /**
     * The consult item left the server queue without this submission
     * dispatching it (for example another client removed it). A consult item
     * is only ever sent by its own dispatch route, so it cannot have gone out
     * raw as a normal message; the caller must not restore the composer and
     * must not re-send, and should tell the user the consultation did not
     * happen.
     */
    status: 'delivered-raw';
    runId: string;
    queueItemRestored: false;
  };

export type ConsultSubmissionHandle = {
  runId: string;
  /** Settles after every cleanup step for the reached terminal state. */
  result: Promise<ConsultSubmissionResult>;
  /**
   * Idempotent cancel before dispatch. It records the cancellation first, then
   * lets the run task remove the queue item / release the hold / cancel the
   * advisor runtime. Unavailable once the acting turn is being dispatched.
   */
  cancel: () => void;
};

/** A queue item as `addToQueue` accepts it (mirrors the composer's capture). */
export type ConsultQueueItemInput = {
  content: string;
  text?: string;
  agentMention?: string;
  attachments?: AttachedFile[];
  context?: QueuedContextPart[];
  sendConfig?: QueuedMessageSendConfig;
  /** Marks the item consult: the generic dispatcher never sends it. */
  kind?: 'consult';
};

/** The queue operations the submission performs, injectable for tests. */
export type ConsultSubmissionQueue = {
  /** Resolves with the authoritative queued item (or undefined when unknown). */
  addToQueue: (target: MessageQueueTarget, message: ConsultQueueItemInput) => Promise<QueuedMessage | undefined>;
  removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
  /** Reserves the head consult item for this owner; throws on refusal. */
  claimConsultItem: (target: MessageQueueTarget, messageId: string, owner?: string, ttlMs?: number) => Promise<QueuedMessage>;
  /** Merges the claimed item's consult payload while its reservation is live. */
  setConsultItemPayload: (
    target: MessageQueueTarget,
    messageId: string,
    owner: string | undefined,
    consult: { system?: string; textPartMetadata?: unknown },
  ) => Promise<void>;
  /** Dispatches the claimed consult item; answers every control-flow case with a structured outcome. */
  dispatchConsultItem: (target: MessageQueueTarget, messageId: string, owner?: string) => Promise<ConsultDispatchOutcome>;
  getQueueForTarget: (target: MessageQueueTarget) => readonly QueuedMessage[];
  /** `owner` scopes the hold so it never clears another feature's hold. */
  setServerHold: (sessionId: string, held: boolean, owner?: string) => Promise<void>;
};

/** The transient run store (`useConsultStore`) as the submission uses it. */
export type ConsultSubmissionRunStore = {
  start: (input: ConsultRunStartInput) => void;
  setPhase: (parentSessionId: string, runId: string, phase: ConsultRunPhase) => void;
  /** Live per-advisor row update (F5); the store guards by runId. */
  updateAdvisor: (
    parentSessionId: string,
    runId: string,
    index: number,
    update: { status?: ConsultAdvisorOutcome['status'] | 'running' | 'queued'; durationMs?: number; reason?: string },
  ) => void;
  finish: (parentSessionId: string, runId: string, summary: ConsultRunFinish) => void;
  cancel: (parentSessionId: string, runId: string) => void;
  /** The run currently owning the parent, or null when there is none. */
  currentOwner: (parentSessionId: string) => string | null;
  /** This exact run's phase, or null when a different/no run owns the parent. */
  currentPhase: (parentSessionId: string, runId: string) => ConsultRunPhase | null;
};

/** The advisor runtime operations the submission performs. */
export type ConsultSubmissionRuntime = {
  startConsultation: (input: StartConsultationInput) => ConsultationHandle;
  cancel: (runId: string) => Promise<void>;
  /**
   * Start-time prevalidation (advisor surface/context) without creating a
   * fork; throws `ConsultationRefusedError` exactly as a start would. The
   * resolved fork point is runtime-internal, so callers receive `void`.
   */
  prevalidateConsultation: (input: StartConsultationInput) => Promise<void>;
};

export type ConsultSubmissionDeps = {
  queue: ConsultSubmissionQueue;
  runs: ConsultSubmissionRunStore;
  runtime: ConsultSubmissionRuntime;
  /** Live status used for admission; defaults to the queue gate's resolver. */
  resolveSessionStatus: (sessionId: string, directory: string) => ConsultSessionStatus;
  /**
   * Whether a running auto-review loop owns the parent session. Auto-review
   * drives the parent through the queue only, so a consult must refuse while it
   * runs; defaults to `useAutoReviewStore.getState().isRunningForSession`.
   */
  isAutoReviewRunning: (sessionId: string) => boolean;
  /**
   * Server capability re-check (F3 close-out): the UI gate is not the only
   * boundary, so every submission re-verifies the connected server before it
   * holds or enqueues anything. Defaults to `resolveConsultLiveCapability`.
   */
  verifyCapability: () => Promise<{ available: true } | { available: false; reason: string; message?: string }>;
  runtimeKey: () => string;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  createRunId?: () => string;
  admissionPollMs?: number;
  /** Re-assert interval for the admission hold; defaults to two minutes. */
  holdReassertMs?: number;
  /** Hold heartbeat scheduler; returns a stop function. Defaults to `setInterval`. */
  scheduleHoldReassert?: (callback: () => void, intervalMs: number) => () => void;
};

type SubmissionCapture = {
  runId: string;
  runtimeKey: string;
  parentSessionId: string;
  target: MessageQueueTarget;
  holdAttempted: boolean;
  /**
   * The terminal release, claimed synchronously once. Its presence means the
   * run is inactive: no later re-assert is accepted, and the heartbeats stop.
   */
  holdRelease: Promise<void> | null;
  /** Serializes hold mutations: re-asserts chain here and the release is last. */
  holdChain: Promise<void>;
  /** Stops the hold heartbeat; set while the heartbeat is live. */
  heartbeatStop: (() => void) | null;
  cancelled: boolean;
  runtimeStarted: boolean;
  /** True only while a dispatch request is actually in flight. */
  dispatching: boolean;
  /**
   * A cancel that arrived while a dispatch request was in flight: ignored for
   * that request (it may already be sending), applied after it settles unless
   * the outcome was `dispatched`.
   */
  cancelRequested: boolean;
  terminal: boolean;
};

type AdmissionOutcome =
  | 'admitted'
  | 'cancelled'
  | 'superseded'
  | 'item-removed'
  | 'auto-review-active'
  | 'runtime-changed';

const defaultCreateRunId = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `consult-submit-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const runtimeMatches = (capture: SubmissionCapture, deps: ConsultSubmissionDeps): boolean =>
  deps.runtimeKey() === capture.runtimeKey;

const toQueueSendConfig = (sendConfig: ConsultSubmissionSendConfig): QueuedMessageSendConfig => {
  const config: QueuedMessageSendConfig = {
    providerID: sendConfig.providerID,
    modelID: sendConfig.modelID,
  };
  if (sendConfig.agent) config.agent = sendConfig.agent;
  if (sendConfig.variant) config.variant = sendConfig.variant;
  return config;
};

const toQueueItemInput = (input: SubmitConsultMessageInput): ConsultQueueItemInput => {
  const item: ConsultQueueItemInput = {
    content: input.message.content,
    sendConfig: toQueueSendConfig(input.sendConfig),
    // Consult items are dispatched only through their claim → payload →
    // dispatch route; the system prompt and receipt metadata are attached
    // later, once the fan-out has settled and the payload route can merge
    // them onto the claimed item.
    kind: 'consult',
  };
  if (input.message.text !== undefined) item.text = input.message.text;
  if (input.message.agentMentionName) item.agentMention = input.message.agentMentionName;
  if (input.message.attachments && input.message.attachments.length > 0) {
    item.attachments = input.message.attachments;
  }
  if (input.message.context && input.message.context.length > 0) item.context = input.message.context;
  return item;
};

const toAdvisorAttachments = (
  attachments: readonly AttachedFile[] | undefined,
): ConsultAttachmentInput[] | undefined => {
  if (!attachments || attachments.length === 0) return undefined;
  return attachments.map((attachment) => {
    const input: ConsultAttachmentInput = {
      type: 'file',
      mime: attachment.mimeType,
      url: attachment.dataUrl,
    };
    if (attachment.filename) input.filename = attachment.filename;
    return input;
  });
};

const toAdvisorOutcomes = (advisors: readonly ConsultAdvisorProvenance[]): ConsultAdvisorOutcome[] =>
  advisors.map((advisor) => {
    const outcome: ConsultAdvisorOutcome = {
      index: advisor.index,
      status: advisor.status,
      durationMs: advisor.durationMs,
    };
    if (advisor.reason) outcome.reason = advisor.reason;
    return outcome;
  });

export const createConsultSubmission = (deps: ConsultSubmissionDeps) => {
  const admissionPollMs = deps.admissionPollMs ?? CONSULT_ADMISSION_POLL_MS;

  /** Stop the hold heartbeat; the hold itself may still be live server-side. */
  const stopHoldHeartbeat = (capture: SubmissionCapture): void => {
    capture.heartbeatStop?.();
    capture.heartbeatStop = null;
  };

  /**
   * Release this run's owner-scoped hold once; a changed runtime leaves it to
   * its server-side expiry. The release is the run's last hold operation: it
   * is claimed synchronously (so no later re-assert is accepted), then it
   * awaits the serialized chain (a re-assert may still be in flight), and only
   * then issues the release. A stale re-assert can therefore never land after
   * the release and resurrect a hold the queue no longer needs.
   */
  const releaseHold = (capture: SubmissionCapture): Promise<void> => {
    stopHoldHeartbeat(capture);
    if (capture.holdRelease) return capture.holdRelease;
    if (!capture.holdAttempted) {
      capture.holdRelease = Promise.resolve();
      return capture.holdRelease;
    }
    capture.holdRelease = (async () => {
      if (!runtimeMatches(capture, deps)) return;
      await capture.holdChain;
      try {
        await deps.queue.setServerHold(capture.parentSessionId, false, consultHoldOwner(capture.runId));
      } catch {
        // Best-effort: the hold expires server-side.
      }
    })();
    return capture.holdRelease;
  };

  /**
   * Append one hold mutation to this run's serialized chain, so hold requests
   * reach the server in the order they were issued and the release is always
   * last. The chain never rejects, so a failed beat cannot poison a release.
   */
  const chainHoldOperation = (
    capture: SubmissionCapture,
    operation: () => Promise<void>,
  ): Promise<void> => {
    const next = capture.holdChain.then(operation, () => undefined).catch(() => undefined);
    capture.holdChain = next;
    return next;
  };

  /**
   * Re-assert the hold for this run's owner. Called at the fan-out start and
   * by the heartbeat, because the server TTL is finite (5 min) and an
   * admission wait or a slow fan-out can outlive it. The beat chains behind
   * the run's other hold operations and is skipped once the release has been
   * claimed, so an in-flight or queued beat can never outlive the release.
   * Best-effort: losing one beat degrades protection, it does not invalidate
   * the taken item, and the next beat retries inside the TTL.
   */
  const reassertHold = async (capture: SubmissionCapture): Promise<void> => {
    if (capture.holdRelease || !capture.holdAttempted) {
      stopHoldHeartbeat(capture);
      return;
    }
    if (!runtimeMatches(capture, deps)) {
      stopHoldHeartbeat(capture);
      return;
    }
    await chainHoldOperation(capture, async () => {
      if (capture.holdRelease) return;
      if (!runtimeMatches(capture, deps)) return;
      try {
        await deps.queue.setServerHold(capture.parentSessionId, true, consultHoldOwner(capture.runId));
      } catch {
        // Best-effort: the queue may still deliver behind items during the fan-out.
      }
    });
  };

  /**
   * Start the hold heartbeat. It begins the moment the hold is acquired, before
   * the enqueue, so neither a slow enqueue nor a long admission wait can let
   * the server TTL lapse; every release and runtime change stops it. The
   * default interval is well inside the server's five-minute TTL.
   */
  const startHoldHeartbeat = (capture: SubmissionCapture): void => {
    if (capture.heartbeatStop || capture.holdRelease || !capture.holdAttempted) return;
    const schedule = deps.scheduleHoldReassert ?? defaultScheduleHoldReassert;
    const intervalMs = deps.holdReassertMs ?? CONSULT_HOLD_REASSERT_MS;
    capture.heartbeatStop = schedule(() => {
      void reassertHold(capture);
    }, intervalMs);
  };

  const waitForAdmission = async (
    input: SubmitConsultMessageInput,
    target: MessageQueueTarget,
    capture: SubmissionCapture,
    itemId: string,
  ): Promise<AdmissionOutcome> => {
    for (;;) {
      if (capture.cancelled) return 'cancelled';
      if (!runtimeMatches(capture, deps)) return 'runtime-changed';
      const owner = deps.runs.currentOwner(input.parentSessionId);
      if (owner !== capture.runId) return owner === null ? 'cancelled' : 'superseded';
      if (deps.runs.currentPhase(input.parentSessionId, capture.runId) === 'cancelled') return 'cancelled';

      const queue = deps.queue.getQueueForTarget(target);
      const index = queue.findIndex((item) => item.id === itemId);
      if (index === -1) return 'item-removed';
      // Auto-review starting after the submission owns the parent now: never
      // take the item, even when it is already the head of an idle session.
      if (deps.isAutoReviewRunning(input.parentSessionId)) return 'auto-review-active';
      if (index === 0 && deps.resolveSessionStatus(input.parentSessionId, input.directory) === 'idle') {
        return 'admitted';
      }
      await deps.sleep(admissionPollMs);
    }
  };

  /**
   * Claim the admitted item for this run's owner, re-polling while the server
   * refuses with a transient condition (session not idle yet, or a different
   * head). Every loop iteration re-checks the same conditions admission
   * waited on, so a cancel, a supersede, an auto-review takeover, or a
   * runtime change still wins over the claim. A persistent refusal surfaces.
   */
  const waitForClaim = async (
    input: SubmitConsultMessageInput,
    target: MessageQueueTarget,
    capture: SubmissionCapture,
    itemId: string,
  ): Promise<QueuedMessage> => {
    for (;;) {
      try {
        return await deps.queue.claimConsultItem(target, itemId, consultHoldOwner(capture.runId));
      } catch (error) {
        if (capture.cancelled) throw error;
        if (!runtimeMatches(capture, deps)) throw error;
        const owner = deps.runs.currentOwner(input.parentSessionId);
        if (owner !== capture.runId) throw error;
        if (deps.runs.currentPhase(input.parentSessionId, capture.runId) === 'cancelled') throw error;
        if (deps.isAutoReviewRunning(input.parentSessionId)) throw error;
        const message = error instanceof Error ? error.message : String(error);
        // The head moved or the session went busy again between the admission
        // check and the claim: wait for the next admission window like
        // waitForAdmission does.
        const retryable = /not-head|not-idle|busy|not found/.test(message);
        const stillQueued = deps.queue.getQueueForTarget(target).some((item) => item.id === itemId);
        if (retryable && stillQueued) {
          await deps.sleep(admissionPollMs);
          continue;
        }
        // The item vanished while the claim was refused: another client
        // removed it (a consult item is never delivered raw by the server).
        throw error;
      }
    }
  };

  const execute = async (
    input: SubmitConsultMessageInput,
    target: MessageQueueTarget,
    capture: SubmissionCapture,
  ): Promise<ConsultSubmissionResult> => {
    const { parentSessionId } = input;
    const { runId } = capture;

    // The submission is the last boundary: even a caller that bypassed the
    // composer's live gate must not hold or enqueue on an unverified server.
    let capability: { available: true } | { available: false; reason: string; message?: string };
    try {
      capability = await deps.verifyCapability();
    } catch (error) {
      capability = {
        available: false,
        reason: 'version-unknown',
        message: `The connected server could not be verified: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!capability.available) {
      const error = capability.message ?? capabilityRefusalMessage(capability.reason);
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error });
      return {
        status: 'refused',
        runId,
        code: 'capability-unavailable',
        error,
        rejections: [],
        queueItemRestored: false,
      };
    }

    // Auto-review owns the parent and drives it through the queue only: a
    // consult must not enqueue, hold, or dispatch while that loop runs.
    if (deps.isAutoReviewRunning(parentSessionId)) {
      return {
        status: 'refused',
        runId,
        code: 'auto-review-active',
        error: AUTO_REVIEW_ACTIVE_MESSAGE,
        rejections: [],
        queueItemRestored: false,
      };
    }

    const fail = (error: string, queueItemRestored = false): ConsultSubmissionResult => {
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error });
      return { status: 'failed', runId, error, queueItemRestored };
    };

    const finishCancelled = (consultation?: ConsultationResult): ConsultSubmissionResult => {
      deps.runs.finish(parentSessionId, runId, { phase: 'cancelled' });
      return consultation
        ? { status: 'cancelled', runId, consultation }
        : { status: 'cancelled', runId };
    };

    const finishRuntimeChanged = (consultation?: ConsultationResult): ConsultSubmissionResult => {
      // The heartbeat must stop even though the hold itself is left to its
      // server-side expiry (it belongs to the runtime that created it).
      stopHoldHeartbeat(capture);
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error: RUNTIME_CHANGED_MESSAGE });
      return consultation
        ? { status: 'failed', runId, error: RUNTIME_CHANGED_MESSAGE, queueItemRestored: false, consultation }
        : { status: 'failed', runId, error: RUNTIME_CHANGED_MESSAGE, queueItemRestored: false };
    };

    const finishDeliveredRaw = (): ConsultSubmissionResult => {
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error: DELIVERED_RAW_MESSAGE });
      return { status: 'delivered-raw', runId, queueItemRestored: false };
    };

    /**
     * A refused or failed consultation after the claim does not re-queue the
     * message: the consult item is removed (the caller restores the composer
     * from its own captured payload on refused/failed), and the hold is
     * released so the sweep never has to revert a stranded reservation.
     */
    const settleWithoutDispatch = async (
      itemId: string,
      error: string,
      refusal: ConsultationRefusedError | null,
    ): Promise<ConsultSubmissionResult> => {
      // A cancel that raced the failure wins: the claimed item is never put
      // back for normal delivery, and the caller restores the composer.
      if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
        if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
        await releaseHold(capture);
        return finishCancelled();
      }
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error });
      if (refusal) {
        return {
          status: 'refused',
          runId,
          code: refusal.code,
          error,
          rejections: refusal.rejections,
          queueItemRestored: false,
        };
      }
      return { status: 'failed', runId, error, queueItemRestored: false };
    };

    deps.runs.start({
      parentSessionId,
      runId,
      mode: input.mode,
      timeoutMs: input.timeoutMs,
      advisors: input.advisors,
    });

    // F2: prevalidate the advisor surface and the parent's settled context
    // BEFORE any hold or queue item exists. An ordinary start refusal then
    // happens while nothing is queued and nothing is held: the caller gets
    // the refused result with `queueItemRestored: false` and restores the
    // composer from its own captured payload — the message is never sent.
    try {
      await deps.runtime.prevalidateConsultation({
        parentSessionId,
        directory: input.directory,
        expectedRuntimeKey: capture.runtimeKey,
        advisors: input.advisors,
        messageText: input.message.text ?? input.message.content,
        attachments: toAdvisorAttachments(input.message.attachments),
        mode: input.mode,
        timeoutMs: input.timeoutMs,
      });
    } catch (error) {
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error: error instanceof Error ? error.message : String(error) });
      if (error instanceof ConsultationRefusedError) {
        return {
          status: 'refused',
          runId,
          code: error.code,
          error: error.message,
          rejections: error.rejections,
          queueItemRestored: false,
        };
      }
      return fail(`Could not start the consultation: ${error instanceof Error ? error.message : String(error)}`);
    }

    // B2: the owner-scoped hold is acquired and awaited BEFORE the item can
    // exist, so the server's 500 ms dispatch quiet timer can never race the
    // hold round trip. The heartbeat starts before the enqueue too, so even a
    // slow enqueue cannot let the TTL lapse.
    capture.holdAttempted = true;
    try {
      await deps.queue.setServerHold(parentSessionId, true, consultHoldOwner(runId));
    } catch (error) {
      // Without the hold the reservation cannot be trusted; nothing was
      // enqueued, so there is nothing to clean up.
      await releaseHold(capture);
      return fail(`Could not hold the session queue for the consult: ${error instanceof Error ? error.message : String(error)}`);
    }
    startHoldHeartbeat(capture);

    if (capture.cancelled) {
      await releaseHold(capture);
      return finishCancelled();
    }
    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();

    // Enqueue exactly as the composer would, now that the session is held.
    // The server returns the authoritative item; there is no snapshot-diff
    // heuristic to attribute the append.
    let enqueued: QueuedMessage | undefined;
    try {
      enqueued = await deps.queue.addToQueue(target, toQueueItemInput(input));
    } catch (error) {
      await releaseHold(capture);
      return fail(`Could not queue the consult message: ${error instanceof Error ? error.message : String(error)}`);
    }
    const itemId = enqueued?.id;
    if (!itemId) {
      await releaseHold(capture);
      return fail('The queued consult item could not be identified by the queue; the message was not dispatched.');
    }

    if (!deps.queue.getQueueForTarget(target).some((entry) => entry.id === itemId)) {
      // The item left the projection right after the enqueue: another client
      // removed it (the server never delivers a consult item raw). Never
      // restore the composer and never re-send.
      await releaseHold(capture);
      return finishDeliveredRaw();
    }

    if (capture.cancelled) {
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      return finishCancelled();
    }
    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();

    const admission = await waitForAdmission(input, target, capture, itemId);
    if (admission !== 'admitted') {
      if (admission === 'runtime-changed') return finishRuntimeChanged();
      if (admission === 'item-removed') {
        // The item left the queue while this submission was waiting for
        // admission: another client removed it (the server never delivers a
        // consult item raw). Never restore and never re-send.
        await releaseHold(capture);
        return finishDeliveredRaw();
      }
      if (admission === 'auto-review-active') {
        // Auto-review took the parent over while this consult waited. Nothing
        // was taken, so this is the cancel path's queue-item semantics: drop
        // the item, release this run's own hold, and let the caller restore
        // the composer through the cancelled result. Idempotent with a cancel
        // that raced it: both end in one removal and one release.
        if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
        await releaseHold(capture);
        return finishCancelled();
      }
      // 'cancelled' and 'superseded' never take the item. Releasing this run's
      // own owner is safe even when superseded: the superseding run holds its
      // own owner, and the server keeps the session held while any owner is
      // live.
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      return finishCancelled();
    }

    let claimedItem: QueuedMessage;
    try {
      claimedItem = await waitForClaim(input, target, capture, itemId);
    } catch (error) {
      if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();
      const message = error instanceof Error ? error.message : String(error);
      // A 'not found' refusal with the item gone from the projection means
      // the item left the queue without this submission claiming it (another
      // client removed it). Never restore the composer (a duplicate send) and
      // never re-send — delivered-raw semantics, like the admission watcher's
      // item-removed outcome.
      const itemGone = !deps.queue.getQueueForTarget(target).some((entry) => entry.id === itemId);
      if (itemGone && /not found/.test(message)) {
        await releaseHold(capture);
        return finishDeliveredRaw();
      }
      // The claim may not have marked the item; releasing the hold lets the
      // sweep clear a stale claim. The item keeps `kind: 'consult'`, so it is
      // never delivered as a normal send — the caller restores the composer.
      await releaseHold(capture);
      return fail(`Could not claim the queued consult item: ${message}`);
    }
    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();

    const takenItem = claimedItem;
    if (!takenItem) {
      // The claim resolved with nothing: the item left the queue without
      // reaching this submission (another client removed it).
      await releaseHold(capture);
      return finishDeliveredRaw();
    }

    if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
      // Cancelled between admission and the fan-out: the item is claimed, so
      // the sweep cannot revert it — remove it directly.
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      return finishCancelled();
    }

    deps.runs.setPhase(parentSessionId, runId, 'consulting');
    let handle: ConsultationHandle;
    try {
      handle = deps.runtime.startConsultation({
        parentSessionId,
        directory: input.directory,
        expectedRuntimeKey: capture.runtimeKey,
        advisors: input.advisors,
        messageText: takenItem.text,
        attachments: toAdvisorAttachments(takenItem.attachments),
        // F4/REQ-4: the advisors must analyze the same current input as the
        // acting turn, so the captured context parts (and their instructions)
        // ride the advisor send exactly as the server delivers them to the
        // acting turn.
        additionalParts: queuedContextToParts(takenItem.context ?? []),
        mode: input.mode,
        timeoutMs: input.timeoutMs,
        runId,
        // F5: live per-advisor progress into the panel's rows. The store
        // guards updates by runId, so a superseded run cannot touch another
        // run's rows; mapping is direct (terminal statuses share the
        // vocabulary, 'running' is the pre-terminal started state).
        onAdvisor: (event) => {
          if (event.phase === 'started') {
            deps.runs.updateAdvisor(parentSessionId, runId, event.index, { status: 'running' });
            return;
          }
          const update = {
            ...(event.status !== undefined && { status: event.status }),
            ...(event.durationMs !== undefined && { durationMs: event.durationMs }),
            ...(event.reason !== undefined && { reason: event.reason }),
          };
          deps.runs.updateAdvisor(parentSessionId, runId, event.index, update);
        },
      });
    } catch (error) {
      return settleWithoutDispatch(
        itemId,
        `Could not start the consultation: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }
    capture.runtimeStarted = true;
    await reassertHold(capture);

    let consultation: ConsultationResult;
    try {
      consultation = await handle.result;
    } catch (error) {
      return settleWithoutDispatch(
        itemId,
        error instanceof Error ? error.message : String(error),
        error instanceof ConsultationRefusedError ? error : null,
      );
    }

    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged(consultation);
    if (consultation.status === 'cancelled') {
      // The claimed item must never survive a cancel: remove it so it cannot
      // be dispatched later; a consult item is never delivered as a normal
      // send.
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      return finishCancelled(consultation);
    }
    if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
      if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
      await releaseHold(capture);
      return finishCancelled(consultation);
    }

    deps.runs.setPhase(parentSessionId, runId, 'settling');
    const degraded = consultation.status === 'degraded';
    const receipt = buildConsultReceipt({
      runId,
      at: deps.now(),
      mode: input.mode,
      acting: { providerID: input.sendConfig.providerID, modelID: input.sendConfig.modelID },
      advisors: consultation.advisors,
      degraded,
    });
    deps.runs.setPhase(parentSessionId, runId, 'dispatching');
    const consultPayload = {
      system: buildConsultSynthesisSystem(consultation.blocks),
      textPartMetadata: toConsultReceiptMetadata(receipt),
    };
    // The consult payload (synthesis system + receipt metadata) is merged onto
    // the claimed item first, so the dispatch route sends the settled
    // consultation with the item's own content.
    try {
      await deps.queue.setConsultItemPayload(target, itemId, consultHoldOwner(capture.runId), consultPayload);
    } catch (error) {
      return settleWithoutDispatch(
        itemId,
        `The consult payload could not be updated: ${error instanceof Error ? error.message : String(error)}`,
        null,
      );
    }

    /**
     * The dispatch outcome is unconfirmed: the message may already be on its
     * way, so the capture is never restored and the item is left to the
     * server. The heartbeat stops, but the hold is deliberately NOT released:
     * the server-owned lease (extended to the max TTL when the dispatch was
     * entered) owns it until the server resolves or it expires. Releasing
     * here would clear the owner hold that `hasActiveConsultReservation`
     * needs, so the proxy prompt gate would stop protecting a parent whose
     * send may still be running. The item + claim stay server-side and are
     * never sent raw; manual removal clears the claim's own hold atomically.
     */
    const settleUncertain = async (error: string): Promise<ConsultSubmissionResult> => {
      stopHoldHeartbeat(capture);
      capture.holdRelease = Promise.resolve();
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error });
      return { status: 'failed', runId, error, queueItemRestored: false, uncertain: true };
    };

    // The acting turn goes through the consult item's own dispatch route: the
    // server verifies the claim, waits for idleness, sends the item with its
    // merged payload, removes it, and releases this owner's hold. Every
    // control-flow answer is a structured outcome: busy is retryable, a lost
    // claim is re-established and the payload re-set, and a definite failure
    // removes the item while an ambiguous one keeps it reserved.
    let reclaims = 0;
    for (;;) {
      // A cancel recorded while a dispatch request was in flight is applied
      // here, once that request has settled without reporting `dispatched`.
      if (capture.cancelRequested && !capture.cancelled) {
        capture.cancelled = true;
        stopHoldHeartbeat(capture);
        deps.runs.cancel(parentSessionId, runId);
        if (capture.runtimeStarted && runtimeMatches(capture, deps)) {
          void deps.runtime.cancel(runId);
        }
      }
      if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
        if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
        await releaseHold(capture);
        return finishCancelled(consultation);
      }
      if (!runtimeMatches(capture, deps)) return finishRuntimeChanged(consultation);
      if (deps.isAutoReviewRunning(parentSessionId)) {
        if (runtimeMatches(capture, deps)) deps.queue.removeFromQueue(target, itemId);
        await releaseHold(capture);
        return finishCancelled(consultation);
      }

      let outcome: ConsultDispatchOutcome;
      // Only a request that is actually in flight blocks cancellation; the
      // waiting between attempts stays cancellable.
      capture.dispatching = true;
      try {
        outcome = await deps.queue.dispatchConsultItem(target, itemId, consultHoldOwner(capture.runId));
      } catch (error) {
        capture.dispatching = false;
        return settleUncertain(
          `The acting message could not be sent: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      capture.dispatching = false;

      if (outcome.status === 'dispatched') break;
      if (outcome.status === 'busy') {
        // Not terminal: the server kept the item; wait out the busy window and
        // retry after re-checking cancel/runtime/auto-review above.
        await deps.sleep(750);
        continue;
      }
      if (outcome.status === 'claim-lost') {
        if (reclaims >= 3) {
          return settleWithoutDispatch(
            itemId,
            'The consult reservation could not be re-established; the message was not sent.',
            null,
          );
        }
        reclaims += 1;
        try {
          await waitForClaim(input, target, capture, itemId);
        } catch (error) {
          return settleWithoutDispatch(
            itemId,
            `The consult reservation could not be re-established: ${error instanceof Error ? error.message : String(error)}`,
            null,
          );
        }
        // The fresh claim needs the settled payload again before the retry.
        try {
          await deps.queue.setConsultItemPayload(target, itemId, consultHoldOwner(capture.runId), consultPayload);
        } catch (error) {
          return settleWithoutDispatch(
            itemId,
            `The consult payload could not be updated: ${error instanceof Error ? error.message : String(error)}`,
            null,
          );
        }
        continue;
      }
      if (outcome.status === 'sending') {
        return settleUncertain(
          'Another dispatch is already in flight for this consult message, so the outcome is unconfirmed; check the session before retrying.',
        );
      }
      if (outcome.status === 'send-failed' && outcome.delivered === 'unknown') {
        return settleUncertain(
          'The consult message could not be confirmed as sent. It stays in the session queue and keeps the session held until the server lease resolves or expires; it will never be sent without a new consultation. Removing the queued consult item releases the session.',
        );
      }
      // not-found / not-consult / send-failed 'no': the message was not sent
      // and (where the server removed it) is no longer queued — a definite
      // failure the caller restores.
      const detail = outcome.status === 'send-failed'
        ? `the server reported it was not delivered (${outcome.delivered})`
        : `the server answered ${outcome.status}`;
      return settleWithoutDispatch(itemId, `The acting message could not be sent: ${detail}.`, null);
    }

    // The server already removed the item and released this owner's hold on a
    // successful dispatch; nothing releases here. The capture's claimed
    // release is resolved without a second server call so no stale release
    // can resurrect the (already released) hold.
    capture.holdRelease = Promise.resolve();
    stopHoldHeartbeat(capture);
    deps.runs.finish(parentSessionId, runId, {
      phase: 'done',
      degraded,
      advisors: toAdvisorOutcomes(consultation.advisors),
    });
    return { status: 'dispatched', runId, receipt, consultation };
  };

  const submitConsultMessage = (input: SubmitConsultMessageInput): ConsultSubmissionHandle => {
    const runId = deps.createRunId?.() ?? defaultCreateRunId();
    const target = createMessageQueueTarget(input.parentSessionId, input.directory, input.runtimeKey);
    if (!target) {
      return {
        runId,
        result: Promise.resolve({
          status: 'failed',
          runId,
          error: 'A consult needs a session, a directory, and a runtime.',
          queueItemRestored: false,
        }),
        cancel: () => undefined,
      };
    }

    const capture: SubmissionCapture = {
      runId,
      runtimeKey: input.runtimeKey,
      parentSessionId: input.parentSessionId,
      target,
      holdAttempted: false,
      holdRelease: null,
      holdChain: Promise.resolve(),
      heartbeatStop: null,
      cancelled: false,
      runtimeStarted: false,
      dispatching: false,
      cancelRequested: false,
      terminal: false,
    };

    const cancel = (): void => {
      if (capture.cancelled || capture.terminal) return;
      if (capture.dispatching) {
        // A dispatch request is in flight and may already be sending: the
        // cancel is recorded and applied after the request settles, unless it
        // comes back `dispatched` (then the turn happened and stands).
        capture.cancelRequested = true;
        return;
      }
      capture.cancelled = true;
      // The heartbeat stops now; the run task releases the hold itself on the
      // path it takes after observing the cancellation.
      stopHoldHeartbeat(capture);
      deps.runs.cancel(input.parentSessionId, runId);
      // A runtime change already abandons the run on its own; cancelling
      // through the new runtime could abort a same-id session there.
      if (capture.runtimeStarted && runtimeMatches(capture, deps)) {
        void deps.runtime.cancel(runId);
      }
    };

    const result = (async (): Promise<ConsultSubmissionResult> => {
      try {
        return await execute(input, target, capture);
      } catch (error) {
        const message = `The consult submission failed unexpectedly: ${error instanceof Error ? error.message : String(error)}`;
        // The run must not stay non-terminal: a stuck record would block the
        // parent's auto-review through the symmetric exclusion guard.
        deps.runs.finish(input.parentSessionId, runId, { phase: 'failed', error: message });
        // Mirror settleUncertain: an error raised while a dispatch request was
        // in flight may have been accepted, so releasing here would clear the
        // owner hold the proxy prompt gate needs. Only a synchronous/unrelated
        // failure keeps today's cleanup release.
        if (capture.dispatching) {
          capture.holdRelease = Promise.resolve();
          return {
            status: 'failed',
            runId,
            error: message,
            queueItemRestored: false,
            uncertain: true,
          };
        }
        await releaseHold(capture);
        return {
          status: 'failed',
          runId,
          error: message,
          queueItemRestored: false,
        };
      } finally {
        capture.terminal = true;
        // Every terminal path releases, but never leave a live interval behind
        // if a future path forgets to.
        stopHoldHeartbeat(capture);
      }
    })();

    return { runId, result, cancel };
  };

  return { submitConsultMessage };
};

const defaultDeps = (): ConsultSubmissionDeps => ({
  queue: {
    addToQueue: (target, message) => useMessageQueueStore.getState().addToQueue(target, message),
    removeFromQueue: (target, messageId) => useMessageQueueStore.getState().removeFromQueue(target, messageId),
    claimConsultItem: (target, messageId, owner, ttlMs) =>
      useMessageQueueStore.getState().claimConsultItem(target, messageId, owner, ttlMs),
    setConsultItemPayload: (target, messageId, owner, consult) =>
      useMessageQueueStore.getState().setConsultItemPayload(target, messageId, owner, consult),
    dispatchConsultItem: (target, messageId, owner) =>
      useMessageQueueStore.getState().dispatchConsultItem(target, messageId, owner),
    getQueueForTarget: (target) => useMessageQueueStore.getState().getQueueForTarget(target),
    setServerHold: (sessionId, held, owner) => useMessageQueueStore.getState().setServerHold(sessionId, held, owner),
  },
  runs: {
    start: (input) => useConsultStore.getState().startRun(input),
    setPhase: (parentSessionId, runId, phase) => useConsultStore.getState().setPhase(parentSessionId, runId, phase),
    updateAdvisor: (parentSessionId, runId, index, update) =>
      useConsultStore.getState().updateAdvisor(parentSessionId, runId, index, update),
    finish: (parentSessionId, runId, summary) => useConsultStore.getState().finish(parentSessionId, runId, summary),
    cancel: (parentSessionId, runId) => useConsultStore.getState().cancel(parentSessionId, runId),
    currentOwner: (parentSessionId) =>
      selectConsultRun(useConsultStore.getState(), parentSessionId)?.runId ?? null,
    currentPhase: (parentSessionId, runId) => {
      const run = selectConsultRun(useConsultStore.getState(), parentSessionId);
      return run && run.runId === runId ? run.phase : null;
    },
  },
  runtime: {
    startConsultation: (input) => consultRuntime.startConsultation(input),
    cancel: (runId) => consultRuntime.cancel(runId),
    prevalidateConsultation: async (input) => {
      await consultRuntime.prevalidateConsultation(input);
    },
  },
  resolveSessionStatus: resolveQueuedSessionStatusType,
  isAutoReviewRunning: (sessionId) => useAutoReviewStore.getState().isRunningForSession(sessionId),
  verifyCapability: async () => {
    const capability = await resolveConsultLiveCapability();
    if (capability.available) return { available: true };
    return { available: false, reason: capability.reason };
  },
  runtimeKey: getRuntimeKey,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Shared submission instance wired to the live queue, run store, and runtime. */
export const consultSubmission = createConsultSubmission(defaultDeps());

/** Start a Consult Models submission; the returned handle owns its lifecycle. */
export const submitConsultMessage = (input: SubmitConsultMessageInput): ConsultSubmissionHandle =>
  consultSubmission.submitConsultMessage(input);
