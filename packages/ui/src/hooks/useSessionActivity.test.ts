import { describe, expect, test } from 'bun:test';

import { deriveSessionActivity } from './sessionActivity';

describe('deriveSessionActivity', () => {
  test('treats a completed trailing assistant message as idle even if status is still busy', () => {
    expect(deriveSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      messages: [{ role: 'assistant', time: { completed: 123 } }],
      permissions: [],
      questions: [],
    }).phase).toBe('idle');
  });

  test('keeps busy when the trailing assistant message is still incomplete', () => {
    expect(deriveSessionActivity({
      sessionId: 'ses_1',
      status: { type: 'busy' },
      messages: [{ role: 'assistant', time: {} }],
      permissions: [],
      questions: [],
    }).isWorking).toBe(true);
  });
});
