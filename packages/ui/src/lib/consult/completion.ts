import type { Message, Part } from '@opencode-ai/sdk/v2';

/**
 * Completion observation for one advisor fork.
 *
 * An advisor turn is a single headless prompt. The only success signal is the
 * trailing assistant message after the sent user message carrying
 * `time.completed` and non-empty visible text. Everything else keeps the
 * outcome unknown until the per-advisor deadline:
 *
 * - a read failure is NOT an empty result (repo invariant). The transcript may
 *   simply not be readable yet, so the read is retried until the deadline and
 *   only then reported as a timeout;
 * - an unfinished trailing assistant message means the turn is still running;
 * - an inherited assistant message (before the sent user message) is never
 *   mistaken for the reply, even if the fork transcript is read before the
 *   sent message becomes visible.
 *
 * Empty visible output, an assistant `error`, and the deadline are explicit
 * failures, so a partial run keeps the other advisors.
 */

export type ConsultMessageRecord = {
  info: Message;
  parts: readonly Part[];
};

export type ConsultCompletionDeps = {
  /** Authoritative read of the fork transcript tail; must reject on failure. */
  readMessages: (sessionID: string, directory: string) => Promise<readonly ConsultMessageRecord[]>;
  /** Injectable clock in milliseconds. */
  now: () => number;
  /** Injectable sleep. */
  sleep: (ms: number) => Promise<void>;
};

export type ConsultCompletionOutcome =
  | { status: 'completed'; messageID: string; text: string }
  | { status: 'empty'; messageID: string; reason: string }
  | { status: 'error'; messageID: string; reason: string }
  | { status: 'timeout'; reason: string }
  | { status: 'cancelled' };

export type ConsultCompletionOptions = {
  sessionID: string;
  directory: string;
  /** Client-generated id of the user message sent into the fork; the reply must follow it. */
  userMessageID: string;
  /** Per-advisor deadline. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  /** Run cancellation token, checked before and after every read. */
  isCancelled?: () => boolean;
};

export const CONSULT_COMPLETION_TIMEOUT_MS = 120_000;
export const CONSULT_COMPLETION_POLL_INTERVAL_MS = 1_000;

/** Visible text is what a user would read: text parts that are not synthetic. */
const isVisibleTextPart = (part: Part): part is Extract<Part, { type: 'text' }> =>
  part.type === 'text' && part.synthetic !== true;

const visibleTextOf = (parts: readonly Part[]): string =>
  parts
    .filter(isVisibleTextPart)
    .map((part) => part.text)
    .join('\n')
    .trim();

const describeAssistantError = (error: NonNullable<Extract<Message, { role: 'assistant' }>['error']>): string => {
  const detail = 'message' in error.data ? String(error.data.message) : '';
  return detail.trim().length > 0 ? `${error.name}: ${detail}` : error.name;
};

/**
 * Read the outcome from one transcript tail, or `null` while the reply has not
 * arrived or is still streaming.
 */
const readReplyOutcome = (
  records: readonly ConsultMessageRecord[],
  userMessageID: string,
): ConsultCompletionOutcome | null => {
  const userIndex = records.findIndex((record) => record.info.id === userMessageID);
  if (userIndex < 0) return null;

  const trailingIndex = records.length - 1;
  if (trailingIndex <= userIndex) return null;
  const trailing = records[trailingIndex];
  const message = trailing?.info;
  if (!message || message.role !== 'assistant') return null;
  if (message.time.completed === undefined) return null;

  if (message.error) {
    return { status: 'error', messageID: message.id, reason: describeAssistantError(message.error) };
  }

  const text = visibleTextOf(trailing.parts);
  if (text.length === 0) {
    return { status: 'empty', messageID: message.id, reason: 'The advisor returned no visible text' };
  }
  return { status: 'completed', messageID: message.id, text };
};

export const waitForConsultAdvisorCompletion = async (
  deps: ConsultCompletionDeps,
  options: ConsultCompletionOptions,
): Promise<ConsultCompletionOutcome> => {
  const timeoutMs = options.timeoutMs ?? CONSULT_COMPLETION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? CONSULT_COMPLETION_POLL_INTERVAL_MS;
  const deadline = deps.now() + timeoutMs;
  let unreadableReads = 0;

  for (;;) {
    if (options.isCancelled?.()) return { status: 'cancelled' };

    let records: readonly ConsultMessageRecord[] | null = null;
    try {
      records = await deps.readMessages(options.sessionID, options.directory);
    } catch {
      // Read failure is unknown, not empty: keep waiting for a readable tail.
      records = null;
      unreadableReads += 1;
    }

    if (options.isCancelled?.()) return { status: 'cancelled' };

    if (records) {
      const outcome = readReplyOutcome(records, options.userMessageID);
      if (outcome) return outcome;
    }

    const now = deps.now();
    if (now >= deadline) {
      const suffix = unreadableReads > 0 ? ` (${unreadableReads} unreadable transcript reads)` : '';
      return { status: 'timeout', reason: `The advisor did not complete within ${timeoutMs} ms${suffix}` };
    }
    await deps.sleep(Math.max(0, Math.min(pollIntervalMs, deadline - now)));
  }
};
