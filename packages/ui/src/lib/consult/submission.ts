import type { TextPartInput } from '@opencode-ai/sdk/v2/client';
import { resolveQueuedSessionStatusType } from '@/hooks/useQueuedMessageAutoSend';
import { queuedContextToParts } from '@/components/chat/composer/submit/buildOutgoingMessage';
import { getRuntimeKey } from '@/lib/runtime-switch';
import {
  createMessageQueueTarget,
  useMessageQueueStore,
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
import { useSessionUIStore } from '@/sync/session-ui-store';
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
 * the queue gate uses). Only then is the item taken, the advisor runtime
 * started, and the original message dispatched in the parent through
 * `useSessionUIStore.sendMessage` with the turn-scoped synthesis `system` and
 * the bounded receipt as `textPartMetadata`.
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
 * Queue-item states on the non-dispatch paths:
 *
 * - cancel before admission removes the item and releases the hold; the caller
 *   restores the composer from its own captured payload and nothing is sent;
 * - the item leaving the queue without this submission taking it (the hold
 *   lapsed and the server delivered it raw, or another client removed it) is
 *   `delivered-raw`: the caller must not restore the composer and must not
 *   re-send, because the message is already delivered or no longer queued;
 * - a start refusal or failure after the item was taken re-adds the item to the
 *   queue and releases the hold, so the message is delivered normally instead
 *   of being dropped; `queueItemRestored` tells the caller not to restore the
 *   composer as well;
 * - a runtime change at any point stops the submission without touching the
 *   queue or the hold: both belong to the runtime that created them, and
 *   session ids are not unique across runtimes;
 * - auto-review taking over the parent while the consult waits for admission
 *   follows the cancel path: the untaken item is removed, the hold is released,
 *   and the composer gets its payload back; a consult submitted while
 *   auto-review already runs is refused with `auto-review-active` before
 *   anything is queued or held.
 *
 * The honest hole (plan section 6, D5): if the UI disappears mid-consult, the
 * heartbeat dies with it, the hold expires, and the server delivers the raw
 * message without the consultation. This module still cannot close that hole
 * client-side, but it now detects the outcome (`delivered-raw`) instead of
 * reporting a cancel that would restore the composer and duplicate the send.
 *
 * The module is dependency-injected (`createConsultSubmission`) so every
 * branch - hold acquisition order, heartbeat, head wait, idle wait, take,
 * dispatch, cancel, partial, all-fail, refusal, runtime change, hold
 * idempotence, item restore, delivered-raw, auto-review exclusion - is testable
 * with an injected queue, run store, runtime, clock, heartbeat scheduler,
 * auto-review predicate, and acting-send function.
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
  'The queued consult message was delivered without a consultation before it could be taken.';
const AUTO_REVIEW_ACTIVE_MESSAGE =
  'A consultation cannot start while the automatic review loop is running for this session.';

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
    code: ConsultationRefusalCode | 'auto-review-active';
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
  }
  | {
    /**
     * The consult item left the server queue without this submission taking
     * it: the server delivered the raw message (a lost or expired hold) or
     * another client removed it. The caller must not restore the composer and
     * must not re-send — the message is already delivered or no longer queued —
     * and should tell the user the consultation did not happen.
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

/** The acting send the live wiring performs through `useSessionUIStore.sendMessage`. */
export type ConsultActingTurn = {
  parentSessionId: string;
  directory: string;
  target: MessageQueueTarget;
  runtimeKey: string;
  message: {
    content: string;
    text: string;
    agentMentionName?: string;
    attachments?: AttachedFile[];
    context: readonly QueuedContextPart[];
  };
  sendConfig: ConsultSubmissionSendConfig;
  /** Turn-scoped guidance; the original message text is not modified. */
  system: string;
  /** Bounded receipt carrier for the acting user message's primary text part. */
  textPartMetadata: TextPartInput['metadata'];
};

/** A queue item as `addToQueue` accepts it (mirrors the composer's capture). */
export type ConsultQueueItemInput = {
  content: string;
  text?: string;
  agentMention?: string;
  attachments?: AttachedFile[];
  context?: QueuedContextPart[];
  sendConfig?: QueuedMessageSendConfig;
};

/** The queue operations the submission performs, injectable for tests. */
export type ConsultSubmissionQueue = {
  addToQueue: (target: MessageQueueTarget, message: ConsultQueueItemInput) => Promise<void>;
  removeFromQueue: (target: MessageQueueTarget, messageId: string) => void;
  takeForSend: (target: MessageQueueTarget, messageId: string) => Promise<QueuedMessage[]>;
  getQueueForTarget: (target: MessageQueueTarget) => readonly QueuedMessage[];
  /** `owner` scopes the hold so it never clears another feature's hold. */
  setServerHold: (sessionId: string, held: boolean, owner?: string) => Promise<void>;
};

/** The transient run store (`useConsultStore`) as the submission uses it. */
export type ConsultSubmissionRunStore = {
  start: (input: ConsultRunStartInput) => void;
  setPhase: (parentSessionId: string, runId: string, phase: ConsultRunPhase) => void;
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
};

export type ConsultSubmissionDeps = {
  queue: ConsultSubmissionQueue;
  runs: ConsultSubmissionRunStore;
  runtime: ConsultSubmissionRuntime;
  /** Dispatches the original message into the parent with the guidance. */
  sendActingTurn: (turn: ConsultActingTurn) => Promise<void>;
  /** Live status used for admission; defaults to the queue gate's resolver. */
  resolveSessionStatus: (sessionId: string, directory: string) => ConsultSessionStatus;
  /**
   * Whether a running auto-review loop owns the parent session. Auto-review
   * drives the parent through the queue only, so a consult must refuse while it
   * runs; defaults to `useAutoReviewStore.getState().isRunningForSession`.
   */
  isAutoReviewRunning: (sessionId: string) => boolean;
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
  dispatching: boolean;
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
    if (attachment.id) input.id = attachment.id;
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

  type EnqueuedItemLookup =
    | { kind: 'found'; itemId: string }
    | { kind: 'missing' }
    | { kind: 'ambiguous' };

  /**
   * The consult item among the entries that appeared since the pre-enqueue
   * snapshot. `addToQueue` generates the id, so identity is derived from the
   * projection; an append that cannot be attributed to this submission is
   * reported instead of risking a foreign item being taken.
   */
  const findEnqueuedItemId = (
    target: MessageQueueTarget,
    knownIds: ReadonlySet<string>,
    content: string,
  ): EnqueuedItemLookup => {
    const appended = deps.queue.getQueueForTarget(target).filter((item) => !knownIds.has(item.id));
    if (appended.length === 0) return { kind: 'missing' };
    if (appended.length === 1) return { kind: 'found', itemId: appended[0].id };
    const matching = appended.filter((item) => item.content === content);
    if (matching.length === 1) return { kind: 'found', itemId: matching[0].id };
    return { kind: 'ambiguous' };
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

  /** Put the taken message back in the queue so it is delivered normally. */
  const restoreTakenItem = async (
    input: SubmitConsultMessageInput,
    target: MessageQueueTarget,
    item: QueuedMessage,
  ): Promise<boolean> => {
    const restored: ConsultQueueItemInput = {
      content: item.content,
      text: item.text,
      sendConfig: item.sendConfig ?? toQueueSendConfig(input.sendConfig),
    };
    if (item.agentMention) restored.agentMention = item.agentMention;
    if (item.attachments && item.attachments.length > 0) restored.attachments = item.attachments;
    if (item.context && item.context.length > 0) restored.context = item.context;
    try {
      await deps.queue.addToQueue(target, restored);
      return true;
    } catch {
      return false;
    }
  };

  const execute = async (
    input: SubmitConsultMessageInput,
    target: MessageQueueTarget,
    capture: SubmissionCapture,
  ): Promise<ConsultSubmissionResult> => {
    const { parentSessionId } = input;
    const { runId } = capture;

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

    const settleWithoutDispatch = async (
      item: QueuedMessage,
      error: string,
      refusal: ConsultationRefusedError | null,
    ): Promise<ConsultSubmissionResult> => {
      // A cancel that raced the failure wins: the taken message is never put
      // back for normal delivery, and the caller restores the composer.
      if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
        await releaseHold(capture);
        return finishCancelled();
      }
      let restored = false;
      if (runtimeMatches(capture, deps)) {
        restored = await restoreTakenItem(input, target, item);
      }
      await releaseHold(capture);
      deps.runs.finish(parentSessionId, runId, { phase: 'failed', error });
      if (refusal) {
        return {
          status: 'refused',
          runId,
          code: refusal.code,
          error,
          rejections: refusal.rejections,
          queueItemRestored: restored,
        };
      }
      return { status: 'failed', runId, error, queueItemRestored: restored };
    };

    deps.runs.start({
      parentSessionId,
      runId,
      mode: input.mode,
      timeoutMs: input.timeoutMs,
      advisors: input.advisors,
    });

    // B2: the owner-scoped hold is acquired and awaited BEFORE the item can
    // exist, so the server's 500 ms dispatch quiet timer can never race the
    // hold round trip. The heartbeat starts before the enqueue too, so even a
    // slow enqueue cannot let the TTL lapse.
    capture.holdAttempted = true;
    try {
      await deps.queue.setServerHold(parentSessionId, true, consultHoldOwner(runId));
    } catch (error) {
      // Without the hold the server may deliver the raw message; nothing was
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
    const knownIds = new Set(deps.queue.getQueueForTarget(target).map((item) => item.id));
    try {
      await deps.queue.addToQueue(target, toQueueItemInput(input));
    } catch (error) {
      await releaseHold(capture);
      return fail(`Could not queue the consult message: ${error instanceof Error ? error.message : String(error)}`);
    }

    const lookup = findEnqueuedItemId(target, knownIds, input.message.content);
    if (lookup.kind === 'missing') {
      // The item is not in the projection without this submission taking it:
      // the raw message was delivered or another client removed it. Never
      // restore the composer (a duplicate send) and never re-send.
      await releaseHold(capture);
      return finishDeliveredRaw();
    }
    if (lookup.kind === 'ambiguous') {
      // A concurrent append cannot be attributed to this submission; never
      // take a possibly-foreign item. The message stays queued, so the caller
      // must not restore the composer either.
      await releaseHold(capture);
      return fail('The queued consult item could not be identified; the message was left in the queue', true);
    }
    const itemId = lookup.itemId;

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
        // admission: the hold lapsed and the server delivered the raw message,
        // or another client removed it. Never restore and never re-send.
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

    let taken: QueuedMessage[];
    try {
      taken = await deps.queue.takeForSend(target, itemId);
    } catch (error) {
      if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();
      // The take may not have removed the item; releasing the hold lets the
      // queue deliver it normally instead of stranding it.
      await releaseHold(capture);
      return fail(`Could not take the queued consult item: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged();

    const takenItem = taken.find((item) => item.id === itemId) ?? taken[0];
    if (!takenItem) {
      // The take resolved with nothing: the item left the queue without
      // reaching this submission, so it may already be delivered raw.
      await releaseHold(capture);
      return finishDeliveredRaw();
    }

    if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
      // Cancelled between admission and the fan-out: the item was taken, so
      // there is nothing left to remove, and it must never be dispatched.
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
        mode: input.mode,
        timeoutMs: input.timeoutMs,
        runId,
      });
    } catch (error) {
      return settleWithoutDispatch(
        takenItem,
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
        takenItem,
        error instanceof Error ? error.message : String(error),
        error instanceof ConsultationRefusedError ? error : null,
      );
    }

    if (!runtimeMatches(capture, deps)) return finishRuntimeChanged(consultation);
    if (consultation.status === 'cancelled') {
      await releaseHold(capture);
      return finishCancelled(consultation);
    }
    if (capture.cancelled || deps.runs.currentPhase(parentSessionId, runId) === 'cancelled') {
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
    capture.dispatching = true;
    try {
      await deps.sendActingTurn({
        parentSessionId,
        directory: input.directory,
        target,
        runtimeKey: capture.runtimeKey,
        message: {
          content: takenItem.content,
          text: takenItem.text,
          agentMentionName: takenItem.agentMention,
          attachments: takenItem.attachments,
          context: takenItem.context ?? [],
        },
        sendConfig: input.sendConfig,
        system: buildConsultSynthesisSystem(consultation.blocks),
        textPartMetadata: toConsultReceiptMetadata(receipt),
      });
    } catch (error) {
      await releaseHold(capture);
      return fail(
        `The acting message could not be sent: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    await releaseHold(capture);
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
      terminal: false,
    };

    const cancel = (): void => {
      if (capture.cancelled || capture.dispatching || capture.terminal) return;
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
    takeForSend: (target, messageId) => useMessageQueueStore.getState().takeForSend(target, messageId),
    getQueueForTarget: (target) => useMessageQueueStore.getState().getQueueForTarget(target),
    setServerHold: (sessionId, held, owner) => useMessageQueueStore.getState().setServerHold(sessionId, held, owner),
  },
  runs: {
    start: (input) => useConsultStore.getState().startRun(input),
    setPhase: (parentSessionId, runId, phase) => useConsultStore.getState().setPhase(parentSessionId, runId, phase),
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
  },
  // The ordinary store send carries the queue's delivery-time behavior for
  // free: session knowledge resolution, the message-sent notification, the
  // captured agent mention, and the attachments.
  sendActingTurn: async (turn) => {
    const additionalParts = queuedContextToParts(turn.message.context);
    await useSessionUIStore.getState().sendMessage(
      turn.message.text,
      turn.sendConfig.providerID,
      turn.sendConfig.modelID,
      turn.sendConfig.agent,
      turn.message.attachments ? [...turn.message.attachments] : undefined,
      turn.message.agentMentionName,
      additionalParts.length > 0 ? additionalParts : undefined,
      turn.sendConfig.variant,
      'normal',
      {
        target: turn.target,
        directory: turn.directory,
        system: turn.system,
        textPartMetadata: turn.textPartMetadata,
      },
    );
  },
  resolveSessionStatus: resolveQueuedSessionStatusType,
  isAutoReviewRunning: (sessionId) => useAutoReviewStore.getState().isRunningForSession(sessionId),
  runtimeKey: getRuntimeKey,
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
});

/** Shared submission instance wired to the live queue, run store, and runtime. */
export const consultSubmission = createConsultSubmission(defaultDeps());

/** Start a Consult Models submission; the returned handle owns its lifecycle. */
export const submitConsultMessage = (input: SubmitConsultMessageInput): ConsultSubmissionHandle =>
  consultSubmission.submitConsultMessage(input);
