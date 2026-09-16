import { describe, expect, mock, test } from 'bun:test';

/**
 * Contract tests for the DEFAULT Enhance Prompt instructions
 * (`composer.enhance.instructions`). The template is the behavioral contract
 * for the rewrite: it must frame the operation as semantic normalization,
 * keep analysis from becoming implementation, and forbid factual invention.
 * These assertions anchor on distinctive phrases of the template, not the
 * full text — the exact wording may evolve, the contract may not.
 *
 * Only `@/lib/runtime-fetch` is replaced (the sibling tests' precedent):
 * the getter under test is pure and touches no network.
 */
mock.module('@/lib/runtime-fetch', () => ({
  runtimeFetch: async (): Promise<Response> => {
    throw new Error('runtime-fetch must not be reached by template lookups');
  },
}));

const { getDefaultMagicPromptTemplate } = await import('@/lib/magicPrompts');

const template = getDefaultMagicPromptTemplate('composer.enhance.instructions');

describe('enhance instructions default template contract', () => {
  test('frames the rewrite as semantic normalization', () => {
    expect(template).toMatch(/semantic normaliz/i);
  });

  test('states the infer-explicit vs invent-facts distinction', () => {
    // Semantic intent already in the wording may be made explicit…
    expect(template).toMatch(/already inherent in the user's wording explicit/i);
    // …while factual context absent from the draft must never be invented.
    expect(template).toMatch(/may not invent factual context/i);
    expect(template).toMatch(/never invent what the draft does not contain/i);
  });

  test('keeps analysis understand-oriented and modification execution-oriented', () => {
    // Understand-oriented verbs must not grow implementation.
    expect(template).toMatch(/stay understand-oriented/i);
    expect(template).toMatch(/do not implement changes/i);
    // Review stays an assessment, never a change.
    expect(template).toMatch(/Review stays review/i);
    // Modification verbs authorize the change but not an invented one.
    expect(template).toMatch(/authorize a change-oriented task/i);
    expect(template).toMatch(/without inventing files, mechanisms, APIs, or tests/i);
  });

  test('never answers or executes the draft', () => {
    expect(template).toMatch(/Never answer it, execute it, or solve the task/i);
  });

  test('preserves unresolved contextual references instead of guessing them', () => {
    expect(template).toMatch(/stay references/i);
    expect(template).toMatch(/preserve them unresolved/i);
    expect(template).toMatch(/Never resolve a vague reference from your own knowledge/i);
  });

  test('keeps a numbered or named target reference as-is', () => {
    expect(template).toMatch(/keep the reference as-is/i);
    expect(template).toMatch(/never resolve it using your own knowledge/i);
  });

  test('calibrates length to how underspecified the draft is', () => {
    expect(template).toMatch(/A precise, actionable draft stays essentially unchanged/i);
    expect(template).toMatch(/a terse one gets its implied intent made explicit/i);
    expect(template).toMatch(/Do not pad/i);
  });

  test('returns only the rewritten prompt', () => {
    expect(template).toMatch(/Return only the rewritten prompt/i);
  });

  test('preserves composer references', () => {
    expect(template).toMatch(/composer references \(@ mentions, \/ commands, # snippets\)/i);
  });

  test('preserves explicit constraints and non-goals', () => {
    expect(template).toMatch(/explicit constraints, non-goals, uncertainty/i);
  });
});
