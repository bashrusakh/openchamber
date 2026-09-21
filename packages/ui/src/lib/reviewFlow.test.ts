import { beforeEach, describe, expect, test } from 'bun:test';
import type { Message } from '@opencode-ai/sdk/v2/client';
import { switchRuntimeEndpoint } from './runtime-switch';

import {
  assertAutoReviewRuntimeStillCurrent,
  assertNoConsultRunActiveForAutoReview,
  claimAutoReviewForward,
  releaseAutoReviewForward,
  hasFinalReviewMarker,
  isAutoReviewRuntimeCurrent,
  isConsultActiveForSession,
  isExpectedAutoReviewAssistantParent,
  startReviewFlow,
  stripFinalReviewMarker,
} from './reviewFlow';
import type { AutoReviewRun } from '@/stores/useAutoReviewStore';
import { useConsultStore } from '@/stores/useConsultStore';

describe('reviewFlow auto-review helpers', () => {
  beforeEach(() => {
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-a.test', runtimeKey: 'runtime-a' });
  });

  test('detects and strips final review marker only from the final line', () => {
    const text = 'No remaining issues.\n\nFINAL_REVIEW_STATUS: no_remaining_findings\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No remaining issues.');
  });

  test('detects and strips final review marker case-insensitively', () => {
    const text = 'No findings.\nFINAL_REVIEW_STATUS: no_remaining_findINGS\n';

    expect(hasFinalReviewMarker(text)).toBe(true);
    expect(stripFinalReviewMarker(text)).toBe('No findings.');
  });

  test('does not treat quoted or non-final marker text as completion', () => {
    const text = 'The marker is FINAL_REVIEW_STATUS: no_remaining_findings, but issues remain.';

    expect(hasFinalReviewMarker(text)).toBe(false);
    expect(stripFinalReviewMarker(text)).toBe(text);
  });

  test('requires assistant parent to match the auto-sent user message when provided', () => {
    const matching = { id: 'msg_assistant_1', parentID: 'msg_user_auto' } as Message;
    const unrelated = { id: 'msg_assistant_2', parentID: 'msg_user_manual' } as Message;

    expect(isExpectedAutoReviewAssistantParent(matching, 'msg_user_auto')).toBe(true);
    expect(isExpectedAutoReviewAssistantParent(unrelated, 'msg_user_auto')).toBe(false);
    expect(isExpectedAutoReviewAssistantParent(unrelated)).toBe(true);
  });

  test('runtime guard rejects runs from a stale runtime', () => {
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(true);
    switchRuntimeEndpoint({ apiBaseUrl: 'http://runtime-b.test', runtimeKey: 'runtime-b' });
    expect(isAutoReviewRuntimeCurrent('runtime-a')).toBe(false);
    expect(() => assertAutoReviewRuntimeStillCurrent('runtime-a')).toThrow('runtime changed');
  });

  test('claims only one in-flight forward for the same auto-review message', () => {
    const run: AutoReviewRun = {
      originalSessionID: 'original-1',
      reviewSessionID: 'review-1',
      directory: '/workspace',
      runtimeKey: 'runtime-a',
      status: 'running',
      phase: 'waiting_for_reviewer',
      iteration: 0,
      maxIterations: 15,
      expectedAssistantParentID: 'msg_user_prompt',
    };

    const key = claimAutoReviewForward(run, 'msg_assistant_review');

    expect(typeof key).toBe('string');
    expect(claimAutoReviewForward(run, 'msg_assistant_review')).toBeNull();

    releaseAutoReviewForward(key!);
    const nextKey = claimAutoReviewForward(run, 'msg_assistant_review');
    expect(nextKey).toBe(key);
    releaseAutoReviewForward(nextKey!);
  });

  test('auto-review refuses to start while a consult run is active for the parent', async () => {
    useConsultStore.getState().startRun({
      parentSessionId: 'original-1',
      runId: 'consult-run-1',
      mode: 'parallel',
      timeoutMs: 120_000,
      advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build' }],
    });
    expect(isConsultActiveForSession('original-1')).toBe(true);

    // The refusal happens before the connection wait and before any message,
    // and reaches the caller's existing toast channel as an Error.
    await expect(startReviewFlow({
      originalSessionID: 'original-1',
      directory: '/workspace',
      providerID: 'anthropic',
      modelID: 'claude',
      autoReview: true,
    })).rejects.toThrow(/consultation is running/i);

    useConsultStore.getState().finish('original-1', 'consult-run-1', { phase: 'cancelled' });
  });

  test('the consult guard releases once the run reaches a terminal phase', () => {
    useConsultStore.getState().startRun({
      parentSessionId: 'original-1',
      runId: 'consult-run-1',
      mode: 'sequential',
      timeoutMs: 120_000,
      advisors: [{ providerID: 'openai', modelID: 'gpt-5', agent: 'build' }],
    });
    expect(isConsultActiveForSession('original-1')).toBe(true);

    useConsultStore.getState().finish('original-1', 'consult-run-1', { phase: 'done' });
    expect(isConsultActiveForSession('original-1')).toBe(false);
    // Does not throw once the run is terminal.
    assertNoConsultRunActiveForAutoReview('original-1');
  });
});
