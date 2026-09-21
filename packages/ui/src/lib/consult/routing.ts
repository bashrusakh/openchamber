import type { Agent, Message, Provider } from '@opencode-ai/sdk/v2';
import { isPrimaryMode } from '@/components/chat/mobileControlsUtils';
import { modelVariantNames } from '@/lib/modelVariants';

/**
 * Consult Models routing decisions: where to fork the parent, and whether the
 * selected advisors exist on the runtime that will run them.
 *
 * Phase 0 A5 proved the pinned OpenCode server does not reject a bad advisor
 * selection before dispatch: an unknown model or agent returns `204` and only
 * surfaces an asynchronous `session.error`, and an unknown variant is dropped
 * silently (the turn runs on the plain model). Client-side validation is
 * therefore the only way to keep the "exact model, no substitution" contract,
 * and it must run before the first fork.
 *
 * This module is pure: callers supply the parent transcript and the real
 * model/agent surface (`config/providers` + `agent`), so it can be verified
 * without a server.
 */

/** One advisor as the picker submits it. */
export type ConsultAdvisorSelection = {
  providerID: string;
  modelID: string;
  /** Thinking level; absent means the model default. */
  variant?: string | null;
  /** Exact agent the advisor runs under; must be a primary agent. */
  agent: string;
};

/** The live surface the advisor selections are validated against. */
export type ConsultModelSurface = {
  providers: readonly Provider[];
  agents: readonly Agent[];
};

export type ConsultAdvisorRejectionCode =
  | 'provider-unknown'
  | 'model-unknown'
  | 'variant-unknown'
  | 'agent-unknown'
  | 'agent-not-primary';

export type ConsultAdvisorRejection = {
  index: number;
  code: ConsultAdvisorRejectionCode;
  message: string;
};

export type ConsultAdvisorValidation =
  | { ok: true }
  | { ok: false; rejections: readonly ConsultAdvisorRejection[] };

/**
 * Validate every advisor against the real model/agent/variant surface.
 *
 * Collects every rejection instead of stopping at the first, because the
 * dialog shows all bad rows at once. A missing provider or model makes the
 * variant unknowable, so the variant check is skipped for that advisor rather
 * than reported twice.
 *
 * The check is deliberately strict: the caller must refuse the whole start
 * when anything is rejected, never fall back to a similar model or the
 * session default.
 */
export const validateConsultAdvisors = (
  selections: readonly ConsultAdvisorSelection[],
  surface: ConsultModelSurface,
): ConsultAdvisorValidation => {
  const rejections: ConsultAdvisorRejection[] = [];

  selections.forEach((selection, index) => {
    const provider = surface.providers.find((candidate) => candidate.id === selection.providerID);
    if (!provider) {
      rejections.push({
        index,
        code: 'provider-unknown',
        message: `Provider "${selection.providerID}" is not available`,
      });
    } else {
      const model = Object.hasOwn(provider.models, selection.modelID)
        ? provider.models[selection.modelID]
        : undefined;
      if (!model) {
        rejections.push({
          index,
          code: 'model-unknown',
          message: `Model "${selection.providerID}/${selection.modelID}" is not available`,
        });
      } else {
        const variant = selection.variant?.trim();
        if (variant && !modelVariantNames(model).includes(variant)) {
          rejections.push({
            index,
            code: 'variant-unknown',
            message: `Variant "${variant}" is not available for "${selection.providerID}/${selection.modelID}"`,
          });
        }
      }
    }

    const agent = surface.agents.find((candidate) => candidate.name === selection.agent);
    if (!agent) {
      rejections.push({
        index,
        code: 'agent-unknown',
        message: `Agent "${selection.agent}" is not available`,
      });
    } else if (!isPrimaryMode(agent.mode)) {
      rejections.push({
        index,
        code: 'agent-not-primary',
        message: `Agent "${selection.agent}" is not a primary agent`,
      });
    }
  });

  return rejections.length === 0 ? { ok: true } : { ok: false, rejections };
};

/**
 * Where the advisor forks branch off the parent transcript.
 *
 * `head` forks the whole settled transcript. `message` forks up to (excluding)
 * that message id, the same defensive fallback `/btw` uses.
 */
export type ConsultForkPoint = { kind: 'head' } | { kind: 'message'; messageID: string };

/**
 * The parent has an unfinished trailing assistant turn and no completed
 * assistant turn before it: there is no settled transcript to inherit and no
 * completed anchor to fork at.
 */
export class ConsultForkPointError extends Error {
  readonly code = 'no-settled-context' as const;

  constructor() {
    super('The parent session has no settled context to fork from');
    this.name = 'ConsultForkPointError';
  }
}

const isUnfinishedAssistantMessage = (message: Message): boolean =>
  message.role === 'assistant' && message.time.completed === undefined;

/**
 * Resolve the fork point for an admitted (authoritatively idle) parent.
 *
 * Queue admission normally means the transcript has settled, so HEAD is the
 * normal answer. When the trailing message is an assistant reply that never
 * completed (a crashed or interrupted turn), forking at HEAD would clone a
 * truncated reply as the newest thing in the advisor's context; the fork then
 * anchors at the last completed assistant message instead.
 *
 * Throws `ConsultForkPointError` when the trailing reply is unfinished and no
 * completed assistant message exists before it.
 */
export const resolveConsultForkPoint = (messages: readonly Message[]): ConsultForkPoint => {
  const trailing = messages[messages.length - 1];
  if (!trailing || !isUnfinishedAssistantMessage(trailing)) return { kind: 'head' };

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== 'assistant') continue;
    if (message.time.completed !== undefined) return { kind: 'message', messageID: message.id };
  }

  throw new ConsultForkPointError();
};
