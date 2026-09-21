import React from 'react';

import type { IconName } from '@/components/icon/icons';
import {
  resolveConsultLiveCapability,
  resolveConsultMechanismCapability,
  type ConsultMechanismCapability,
} from '@/lib/consult/capability';
import type {
  ConsultAdvisorRejection,
  ConsultAdvisorSelection,
} from '@/lib/consult/routing';
import type { ConsultSubmissionResult, SubmitConsultMessageInput } from '@/lib/consult/submission';
import type { I18nKey, I18nParams } from '@/lib/i18n';
import type { ConsultAdvisorRunStatus, ConsultRunPhase } from '@/stores/useConsultStore';

/**
 * Presentation mappings for the Consult Models UI (WP2.2/WP2.3).
 *
 * The module keeps the presentation rules testable without a composer or a
 * run. It owns no state: the run's authority is `stores/useConsultStore.ts`
 * plus the submission handle, and the component tree only renders what they
 * report. Availability reads the runtime capability from
 * `resolveConsultMechanismCapability()` instead of each caller checking the
 * queue itself.
 */

export const CONSULT_ADVISOR_MIN = 2;
export const CONSULT_ADVISOR_MAX = 5;
export const DEFAULT_CONSULT_TIMEOUT_MS = 120_000;

/** Per-advisor deadline presets offered by the dialog. */
export const CONSULT_TIMEOUT_PRESETS: ReadonlyArray<{ timeoutMs: number; labelKey: I18nKey }> = [
  { timeoutMs: 30_000, labelKey: 'chat.consult.dialog.timeout.30s' },
  { timeoutMs: 60_000, labelKey: 'chat.consult.dialog.timeout.1m' },
  { timeoutMs: 120_000, labelKey: 'chat.consult.dialog.timeout.2m' },
  { timeoutMs: 300_000, labelKey: 'chat.consult.dialog.timeout.5m' },
];

/** Everything the submission needs except the per-run advisor options. */
export type ConsultSubmissionCapture = Omit<SubmitConsultMessageInput, 'advisors' | 'mode' | 'timeoutMs'>;

/**
 * Why the composer action is not offered.
 *
 * A busy session is deliberately absent: it is not an unavailability state.
 * The consult is admitted through the server-authoritative message queue, so
 * the action stays available while a turn runs and the submission waits for
 * the queue head and an idle session. A running auto-review loop owns the
 * parent's queue-only workflow, so it is an unavailability state.
 */
export type ConsultUnavailableReason =
  | 'no-session'
  | 'unsupported-runtime'
  | 'version-unknown'
  | 'version-unsupported'
  | 'consult-active'
  | 'auto-review-active'
  | 'btw-active'
  | 'shell-command'
  | 'slash-command';

export type ConsultAvailabilityInput = {
  /** A real session and directory exist; a new-session draft is not enough. */
  hasSession: boolean;
  /** The composer text. A leading `/` routes to a command instead. */
  input: string;
  /** Shell mode sends the text as a shell command, never as a prompt. */
  shellMode: boolean;
  btwActive: boolean;
  consultActive: boolean;
  /** A running auto-review loop owns the parent session. */
  autoReviewActive: boolean;
};

type ConsultAvailability =
  | { available: true }
  | { available: false; reason: ConsultUnavailableReason };

/**
 * The action's availability, most fundamental reason first so the tooltip
 * explains the state the user cannot change from the composer before a
 * transient one they can.
 *
 * The mechanism gate comes from the caller: a synchronous
 * `resolveConsultMechanismCapability()` result (runtime gate only) or the
 * composed live gate resolved by `useConsultLiveCapability` (runtime gate +
 * the connected server's OpenCode version, F3 fail-closed). The live gate is
 * the composer entry point's source of truth; the sync resolver stays for
 * callers that render before the version read settles.
 */
export const resolveConsultAvailability = (
  input: ConsultAvailabilityInput & { mechanism?: ConsultMechanismCapability },
): ConsultAvailability => {
  if (!input.hasSession) return { available: false, reason: 'no-session' };
  const mechanism = input.mechanism ?? resolveConsultMechanismCapability();
  if (!mechanism.available) return { available: false, reason: mechanism.reason };
  if (input.consultActive) return { available: false, reason: 'consult-active' };
  if (input.autoReviewActive) return { available: false, reason: 'auto-review-active' };
  if (input.btwActive) return { available: false, reason: 'btw-active' };
  if (input.shellMode) return { available: false, reason: 'shell-command' };
  if (input.input.trimStart().startsWith('/')) return { available: false, reason: 'slash-command' };
  return { available: true };
};

/**
 * The live server capability for the composer (F3): runtime gate + OpenCode
 * version, resolved once per mount and refetchable. Until it settles the
 * action keeps the synchronous runtime gate's answer, so a VS Code runtime is
 * disabled immediately while a server-queue runtime briefly shows the
 * conservative unverified state before the version lands.
 */
export const useConsultLiveCapability = () => {
  const [capability, setCapability] = React.useState<ConsultMechanismCapability>(
    () => resolveConsultMechanismCapability(),
  );
  const [generation, setGeneration] = React.useState(0);

  React.useEffect(() => {
    let stale = false;
    setCapability(resolveConsultMechanismCapability());
    resolveConsultLiveCapability()
      .then((resolved) => {
        if (!stale) setCapability(resolved);
      })
      .catch(() => {
        if (!stale) setCapability({ available: false, reason: 'version-unknown' });
      });
    return () => {
      stale = true;
    };
  }, [generation]);

  const refetch = React.useCallback(() => setGeneration((value) => value + 1), []);
  return { capability, refetch };
};

export const consultUnavailableLabelKey = (reason: ConsultUnavailableReason): I18nKey => {
  switch (reason) {
    case 'no-session':
      return 'chat.consult.unavailable.noSession';
    case 'unsupported-runtime':
      return 'chat.consult.unavailable.runtime';
    case 'version-unknown':
      return 'chat.consult.unavailable.versionUnknown';
    case 'version-unsupported':
      return 'chat.consult.unavailable.versionUnsupported';
    case 'consult-active':
      return 'chat.consult.unavailable.active';
    case 'auto-review-active':
      return 'chat.consult.unavailable.autoReview';
    case 'btw-active':
      return 'chat.consult.unavailable.btw';
    case 'shell-command':
      return 'chat.consult.unavailable.shellCommand';
    case 'slash-command':
      return 'chat.consult.unavailable.slashCommand';
  }
};

export const consultStatusLabelKey = (status: ConsultAdvisorRunStatus): I18nKey => {
  switch (status) {
    case 'queued':
      return 'chat.consult.status.queued';
    case 'running':
      return 'chat.consult.status.running';
    case 'ok':
      return 'chat.consult.status.ok';
    case 'failed':
      return 'chat.consult.status.failed';
    case 'timeout':
      return 'chat.consult.status.timeout';
    case 'empty':
      return 'chat.consult.status.empty';
    case 'cancelled':
      return 'chat.consult.status.cancelled';
  }
};

type ConsultStatusPresentation = {
  icon: IconName;
  /** Status colors are reserved for actual feedback; quiet rows stay muted. */
  className: string;
};

export const consultStatusPresentation = (status: ConsultAdvisorRunStatus): ConsultStatusPresentation => {
  switch (status) {
    case 'queued':
      return { icon: 'time', className: 'text-muted-foreground' };
    case 'running':
      return { icon: 'loader-4', className: 'text-[var(--status-info)] animate-spin' };
    case 'ok':
      return { icon: 'check', className: 'text-[var(--status-success)]' };
    case 'failed':
      return { icon: 'error-warning', className: 'text-[var(--status-error)]' };
    case 'timeout':
      return { icon: 'timer', className: 'text-[var(--status-warning)]' };
    case 'empty':
      return { icon: 'question', className: 'text-[var(--status-warning)]' };
    case 'cancelled':
      return { icon: 'close-circle', className: 'text-muted-foreground' };
  }
};

/**
 * Cancel is offered only before dispatch. Once the acting turn is being sent
 * (`dispatching` and later) the run owns the message; the parent's normal stop
 * control is the only correct action.
 */
export const isConsultRunCancellable = (phase: ConsultRunPhase): boolean =>
  phase === 'waiting-admission' || phase === 'consulting' || phase === 'settling';

export const isConsultRunTerminal = (phase: ConsultRunPhase): boolean =>
  phase === 'done' || phase === 'failed' || phase === 'cancelled';

/** Whole seconds, so a 120 s default reads as a duration and not a clock. */
export const formatConsultDuration = (
  t: (key: I18nKey, params?: I18nParams) => string,
  durationMs: number | undefined,
): string | null => {
  if (durationMs === undefined) return null;
  return t('chat.consult.duration.seconds', { seconds: Math.max(0, Math.round(durationMs / 1000)) });
};

/**
 * True when the queue item left the queue without this submission taking it:
 * the server may have delivered the raw message, or another client may have
 * removed it. Either way the composer must not restore or re-send the capture.
 *
 * The status is read through the widened union on purpose: the core result
 * union is widened with `delivered-raw` by a parallel work package, and the
 * composer branch must stay correct whether or not that member already
 * exists, so this UI change can land independently of the core change.
 */
export const isDeliveredRawSubmission = (
  status: ConsultSubmissionResult['status'] | 'delivered-raw',
): boolean => status === 'delivered-raw';

/**
 * The settled submission shapes the composer reacts to after `dispatched`.
 * Structural on purpose: the disposition does not need the rest of the result,
 * and `delivered-raw` is named here so the rule holds whether or not the core
 * union already carries the member.
 */
type ConsultCaptureSettlement =
  | { status: 'cancelled' }
  | { status: 'refused' | 'failed' | 'delivered-raw'; queueItemRestored: boolean };

/**
 * Whether the composer gives its captured payload back after a settled
 * submission that did not dispatch. A cancelled run always restores. A
 * `delivered-raw` run never does: the message may already have been sent
 * without the consult, so restoring the capture could send it a second time.
 * A refusal or failure restores only when the submission did not put the
 * queue item back itself (`queueItemRestored` false).
 */
export const consultCaptureDisposition = (result: ConsultCaptureSettlement): 'keep' | 'restore' => {
  if (result.status === 'cancelled') return 'restore';
  if (isDeliveredRawSubmission(result.status)) return 'keep';
  return result.queueItemRestored ? 'keep' : 'restore';
};

/**
 * One localized line per rejected advisor, in selection order, for the
 * refusal notice. Each line is a complete message (`Advisor {index}: ...`),
 * never assembled from translated fragments.
 *
 * A rejection carries only its index, code, and an English message, so the
 * identity shown in the line comes from the exact selection the dialog
 * submitted (`advisors[rejection.index]`). Returns null when nothing was
 * rejected.
 */
export const formatConsultRejections = (
  t: (key: I18nKey, params?: I18nParams) => string,
  rejections: readonly ConsultAdvisorRejection[],
  advisors: readonly ConsultAdvisorSelection[],
): string[] | null => {
  if (rejections.length === 0) return null;
  return rejections.map((rejection) => {
    const index = rejection.index + 1;
    const advisor = advisors[rejection.index];
    if (!advisor) return t('chat.consult.rejection.unknown', { index });
    const model = `${advisor.providerID}/${advisor.modelID}`;
    switch (rejection.code) {
      case 'provider-unknown':
        return t('chat.consult.rejection.providerUnknown', { index, provider: advisor.providerID });
      case 'model-unknown':
        return t('chat.consult.rejection.modelUnknown', { index, model });
      case 'variant-unknown':
        return t('chat.consult.rejection.variantUnknown', {
          index,
          variant: advisor.variant ?? '',
          model,
        });
      case 'agent-unknown':
        return t('chat.consult.rejection.agentUnknown', { index, agent: advisor.agent });
      case 'agent-not-primary':
        return t('chat.consult.rejection.agentNotPrimary', { index, agent: advisor.agent });
    }
  });
};
