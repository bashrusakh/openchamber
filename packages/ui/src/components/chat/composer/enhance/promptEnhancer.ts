/**
 * The composer's Enhance Prompt service: rewrites the current draft with the
 * Small Model, instructed by the `composer.enhance.instructions` magic prompt.
 *
 * The draft is the only user content that travels into the request — no
 * conversation history, attachments, or other context. Everything that makes
 * the request is either the draft itself or the rendered instructions, so a
 * leaked override stays contained to its own prompt.
 *
 * Request conventions follow `sessionTitle.ts` / `smallModel.ts`: the small
 * model is resolved server-side, `restrictToPreferredProvider` pins the
 * session provider when one is known, and `onOverflow: 'error'` refuses to
 * truncate — a rewritten prompt with its tail silently clipped would read as
 * confident nonsense.
 */

import { z } from 'zod';
import { renderMagicPrompt } from '@/lib/magicPrompts';
import { requestSmallModel } from '@/lib/smallModelRequest';

/** Magic prompt holding the enhancer's system instructions. */
const ENHANCE_INSTRUCTIONS_ID = 'composer.enhance.instructions';

/** Why an enhance attempt failed. The UI layer maps each reason to its copy. */
export type PromptEnhanceFailure =
  | 'unavailable'        // 404 — no small model resolved
  | 'provider-failed'    // any other non-ok response
  | 'context-too-small'  // 413 — the draft exceeds the model's input budget
  | 'empty-result'       // the model answered with nothing usable
  | 'invalid-result'     // protected composer tokens were lost or invented
  | 'aborted';           // the caller cancelled

export class PromptEnhanceError extends Error {
  readonly reason: PromptEnhanceFailure;

  constructor(reason: PromptEnhanceFailure, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PromptEnhanceError';
    this.reason = reason;
  }
}

export interface PromptEnhanceContext {
  directory: string;
  sessionId?: string | null;
  preferredProviderId?: string | null;
  preferredModelId?: string | null;
}

interface SmallModelErrorPayload {
  error?: string;
  code?: string;
}

/** The `/api/small-model/generate` request the enhance action sends. */
export interface EnhanceRequestBody {
  system: string;
  prompt: string;
  directory: string;
  sessionID?: string;
  preferredProviderID?: string;
  preferredModelID?: string;
  restrictToPreferredProvider: boolean;
  onOverflow: 'error';
}

/**
 * Builds the request body from the draft and the enhance context. Exported
 * for tests; `enhancePrompt` is the only production caller.
 */
export const buildEnhanceRequestBody = (
  draft: string,
  system: string,
  context: PromptEnhanceContext,
): EnhanceRequestBody => {
  const body: EnhanceRequestBody = {
    system,
    prompt: draft,
    directory: context.directory,
    restrictToPreferredProvider: true,
    onOverflow: 'error',
  };
  if (context.sessionId) body.sessionID = context.sessionId;
  if (context.preferredProviderId) body.preferredProviderID = context.preferredProviderId;
  if (context.preferredModelId) body.preferredModelID = context.preferredModelId;
  return body;
};

/**
 * Strips exactly one level of model dressing from the response: the outer
 * markdown fence (```…``` with optional language tag) or one pair of matching
 * straight quotes, then trims. An inner fence or quotes survive — the model
 * may legitimately return a fenced prompt as its content.
 */
export const cleanEnhancedPromptText = (text: string): string => {
  const trimmed = text.trim();

  const fence = trimmed.match(/^```[^\n`]*\n([\s\S]*?)\n?```$/);
  if (fence) {
    return fence[1].trim();
  }

  for (const quote of ['"', "'"] as const) {
    if (trimmed.startsWith(quote) && trimmed.endsWith(quote) && trimmed.length >= 2) {
      const inner = trimmed.slice(1, -1);
      // Only strip a real wrapper pair, not a string that merely ends with
      // the same character it starts with ("don't" keeps its opening quote).
      if (!(inner.startsWith(quote) && inner.endsWith(quote))) {
        return inner.trim();
      }
      break;
    }
  }

  return trimmed;
};

const successSchema = z.object({ text: z.string().min(1) });
const errorSchema = z.object({ error: z.string().optional(), code: z.string().optional() });

const decodeResponsePayload = async (response: Response): Promise<z.infer<typeof successSchema> | null> => {
  const body: unknown = await response.json().catch(() => null);
  const parsed = successSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

const decodeErrorPayload = async (response: Response): Promise<SmallModelErrorPayload | null> => {
  const body: unknown = await response.json().catch(() => null);
  const parsed = errorSchema.safeParse(body);
  return parsed.success ? parsed.data : null;
};

const describeFailure = async (response: Response): Promise<PromptEnhanceError> => {
  const payload = await decodeErrorPayload(response);
  const detail = payload?.error;
  if (response.status === 404) {
    // The route passes the backend's "no small model" message through
    // verbatim; it names why nothing resolved.
    return new PromptEnhanceError(
      'unavailable',
      detail || 'No small model is available for prompt enhancement.',
    );
  }
  if (response.status === 413) {
    return new PromptEnhanceError(
      'context-too-small',
      detail || 'The draft is too large for the current Small Model context.',
    );
  }
  return new PromptEnhanceError(
    'provider-failed',
    detail || `The small model could not enhance the prompt (status ${response.status}).`,
  );
};

/**
 * Rewrites `draft` with the Small Model. Throws `PromptEnhanceError` with a
 * `reason` the caller can map to UI copy; `aborted` is silent by convention.
 *
 * The enhance request carries no conversation history, attachments, or extra
 * context: the draft is the only user content.
 */
export const enhancePrompt = async (
  draft: string,
  context: PromptEnhanceContext,
  signal: AbortSignal,
): Promise<string> => {
  const instructions = await renderMagicPrompt(ENHANCE_INSTRUCTIONS_ID);
  if (!instructions.trim()) {
    // The default template is never empty; an override that lands here
    // produces nothing the request could use, so it stops before sending.
    // `empty-result` carries the Enhance-specific toast copy for a result
    // that has nothing usable in it.
    throw new PromptEnhanceError('empty-result', 'The prompt enhancer instructions are empty.');
  }

  let response: Response;
  try {
    response = await requestSmallModel(
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify(buildEnhanceRequestBody(draft, instructions, context)),
      },
      // 404 ("no small model available") and 413 (draft over the context
      // budget) are Enhance-specific failures whose copy comes from the
      // thrown error, so the shared toast is silenced for both statuses —
      // the toast dedupes by id regardless.
      { silentStatuses: [404, 413] },
    );
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      // requestSmallModel already exempts aborts from its toast; rethrow as
      // the typed error so the hook can treat the cancellation silently.
      throw new PromptEnhanceError('aborted', 'Prompt enhancement was cancelled.', { cause: error });
    }
    throw error;
  }

  if (!response.ok) {
    throw await describeFailure(response);
  }

  const payload = await decodeResponsePayload(response);
  const cleaned = cleanEnhancedPromptText(payload?.text ?? '');
  if (!cleaned) {
    throw new PromptEnhanceError('empty-result', 'The small model returned an empty prompt.');
  }
  return cleaned;
};
