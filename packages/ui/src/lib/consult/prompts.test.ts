import { describe, expect, test } from 'bun:test';
import { CONSULT_ADVISOR_SYSTEM_PROMPT } from './prompts';

describe('advisor framing prompt', () => {
  test('frames the advisor as a one-turn independent advisor, not the acting agent', () => {
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('independent advisor answering exactly one turn');
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('not the acting agent');
  });

  test('marks the inherited conversation as reference and the user message as the task', () => {
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('reference material inherited from the main thread');
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('only task');
  });

  test('states the tool-free surface and forbids tool and sub-agent claims', () => {
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('You have no tools and no sub-agents');
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('Never claim or imply');
  });

  test('asks for concise text guidance without questions', () => {
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('concise, private guidance');
    expect(CONSULT_ADVISOR_SYSTEM_PROMPT).toContain('plain text guidance only');
  });
});
