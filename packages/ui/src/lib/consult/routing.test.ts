import { describe, expect, test } from 'bun:test';
import type { Agent, Message, Provider } from '@opencode-ai/sdk/v2';
import {
  ConsultForkPointError,
  pickDefaultAdvisorModels,
  resolveConsultForkPoint,
  validateConsultAdvisors,
  type ConsultAdvisorSelection,
  type ConsultModelLists,
  type ConsultModelProvider,
  type ConsultModelRef,
  type ConsultModelSurface,
} from './routing';

const userMessage = (id: string): Message => ({
  id,
  sessionID: 'parent',
  role: 'user',
  time: { created: 1 },
  agent: 'build',
  model: { providerID: 'anthropic', modelID: 'claude' },
});

const assistantMessage = (id: string, completed: number | undefined): Message => {
  // SAFETY: resolveConsultForkPoint reads only role, id, and time.completed;
  // the rest of AssistantMessage is irrelevant to the fork-point decision.
  return { id, sessionID: 'parent', role: 'assistant', time: { created: 1, completed } } as Message;
};

const providerModel = (id: string, variants?: Record<string, string>): Provider['models'][string] => {
  // SAFETY: validation reads only `id` and `variants`; the remaining Model
  // fields are server-owned data that routing never touches.
  return { id, variants } as Provider['models'][string];
};

const provider = (id: string, models: Provider['models']): Provider => ({
  id,
  name: id,
  source: 'config',
  env: [],
  options: {},
  models,
});

const agent = (name: string, mode: Agent['mode']): Agent => ({
  name,
  mode,
  permission: [],
  options: {},
});

const selection = (overrides?: Partial<ConsultAdvisorSelection>): ConsultAdvisorSelection => ({
  providerID: 'anthropic',
  modelID: 'claude',
  agent: 'build',
  ...overrides,
});

const surface = (): ConsultModelSurface => ({
  providers: [
    provider('anthropic', {
      claude: providerModel('claude', { high: 'high', low: 'low' }),
      haiku: providerModel('haiku'),
    }),
  ],
  agents: [agent('build', 'primary'), agent('plan', 'all'), agent('explore', 'subagent')],
});

describe('resolveConsultForkPoint', () => {
  test('an empty transcript forks at HEAD', () => {
    expect(resolveConsultForkPoint([])).toEqual({ kind: 'head' });
  });

  test('a settled transcript forks at HEAD', () => {
    expect(resolveConsultForkPoint([userMessage('u1'), assistantMessage('a1', 10)])).toEqual({ kind: 'head' });
  });

  test('a trailing user message forks at HEAD', () => {
    expect(resolveConsultForkPoint([assistantMessage('a1', 10), userMessage('u2')])).toEqual({ kind: 'head' });
  });

  test('an unfinished trailing reply falls back to the last completed assistant message', () => {
    const messages = [userMessage('u1'), assistantMessage('a1', 10), userMessage('u2'), assistantMessage('a2', undefined)];
    expect(resolveConsultForkPoint(messages)).toEqual({ kind: 'message', messageID: 'a1' });
  });

  test('an unfinished first turn has no settled context', () => {
    expect(() => resolveConsultForkPoint([userMessage('u1'), assistantMessage('a1', undefined)]))
      .toThrow(ConsultForkPointError);
  });

  test('an unfinished trailing reply with only earlier user messages has no settled context', () => {
    expect(() => resolveConsultForkPoint([userMessage('u1'), userMessage('u2'), assistantMessage('a2', undefined)]))
      .toThrow(ConsultForkPointError);
  });
});

describe('validateConsultAdvisors', () => {
  test('accepts an exact available selection, with and without a variant', () => {
    expect(validateConsultAdvisors([selection(), selection({ modelID: 'haiku' })], surface())).toEqual({ ok: true });
    expect(validateConsultAdvisors([selection({ variant: 'high' })], surface())).toEqual({ ok: true });
  });

  test('rejects an unknown provider without inventing a fallback', () => {
    const result = validateConsultAdvisors([selection({ providerID: 'openai' })], surface());
    expect(result).toEqual({
      ok: false,
      rejections: [{ index: 0, code: 'provider-unknown', message: 'Provider "openai" is not available' }],
    });
  });

  test('rejects an unknown model, including prototype keys', () => {
    expect(validateConsultAdvisors([selection({ modelID: 'gpt' })], surface())).toEqual({
      ok: false,
      rejections: [{ index: 0, code: 'model-unknown', message: 'Model "anthropic/gpt" is not available' }],
    });
    expect(validateConsultAdvisors([selection({ modelID: '__proto__' })], surface())).toEqual({
      ok: false,
      rejections: [{ index: 0, code: 'model-unknown', message: 'Model "anthropic/__proto__" is not available' }],
    });
  });

  test('rejects an unknown variant and accepts a known one', () => {
    expect(validateConsultAdvisors([selection({ variant: 'max' })], surface())).toEqual({
      ok: false,
      rejections: [
        { index: 0, code: 'variant-unknown', message: 'Variant "max" is not available for "anthropic/claude"' },
      ],
    });
    expect(validateConsultAdvisors([selection({ variant: 'high' })], surface())).toEqual({ ok: true });
    // A model without variants rejects any explicit variant.
    expect(validateConsultAdvisors([selection({ modelID: 'haiku', variant: 'high' })], surface())).toEqual({
      ok: false,
      rejections: [
        { index: 0, code: 'variant-unknown', message: 'Variant "high" is not available for "anthropic/haiku"' },
      ],
    });
  });

  test('rejects an unknown agent and a non-primary agent', () => {
    expect(validateConsultAdvisors([selection({ agent: 'ghost' })], surface())).toEqual({
      ok: false,
      rejections: [{ index: 0, code: 'agent-unknown', message: 'Agent "ghost" is not available' }],
    });
    expect(validateConsultAdvisors([selection({ agent: 'explore' })], surface())).toEqual({
      ok: false,
      rejections: [{ index: 0, code: 'agent-not-primary', message: 'Agent "explore" is not a primary agent' }],
    });
    // `all` and an absent mode both count as primary.
    expect(validateConsultAdvisors([selection({ agent: 'plan' })], surface())).toEqual({ ok: true });
  });

  test('reports every bad advisor and every reason for one advisor', () => {
    const result = validateConsultAdvisors(
      [selection({ modelID: 'gpt', agent: 'explore' }), selection({ providerID: 'openai' }), selection()],
      surface(),
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected rejections');
    expect(result.rejections).toEqual([
      { index: 0, code: 'model-unknown', message: 'Model "anthropic/gpt" is not available' },
      { index: 0, code: 'agent-not-primary', message: 'Agent "explore" is not a primary agent' },
      { index: 1, code: 'provider-unknown', message: 'Provider "openai" is not available' },
    ]);
  });
});

const catalogProvider = (id: string, modelIDs: readonly string[]): ConsultModelProvider => ({
  id,
  models: modelIDs.map((modelID) => ({ id: modelID })),
});

const modelRef = (providerID: string, modelID: string): ConsultModelRef => ({ providerID, modelID });

const modelLists = (overrides?: Partial<ConsultModelLists>): ConsultModelLists => ({
  favoriteModels: [],
  recentModels: [],
  hiddenModels: [],
  ...overrides,
});

const catalog = (): ConsultModelProvider[] => [
  catalogProvider('anthropic', ['claude', 'haiku']),
  catalogProvider('openai', ['gpt', 'o3']),
];

describe('pickDefaultAdvisorModels', () => {
  test('favorites win, in favorite order', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('openai', 'gpt'), modelRef('anthropic', 'claude')],
    }))).toEqual([modelRef('openai', 'gpt'), modelRef('anthropic', 'claude')]);
  });

  test('recents fill the pair after favorites, never repeating one', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('anthropic', 'claude')],
      recentModels: [modelRef('anthropic', 'claude'), modelRef('anthropic', 'haiku'), modelRef('openai', 'gpt')],
    }))).toEqual([modelRef('anthropic', 'claude'), modelRef('anthropic', 'haiku')]);
  });

  test('hidden models are excluded from favorites, recents and the catalog', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('anthropic', 'claude')],
      recentModels: [modelRef('openai', 'o3')],
      hiddenModels: [modelRef('anthropic', 'claude'), modelRef('openai', 'o3')],
    }))).toEqual([modelRef('anthropic', 'haiku'), modelRef('openai', 'gpt')]);
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      hiddenModels: [modelRef('anthropic', 'claude')],
    }))).toEqual([modelRef('anthropic', 'haiku'), modelRef('openai', 'gpt')]);
  });

  test('the catalog fills the pair when the lists have nothing usable, capped at count', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists()))
      .toEqual([modelRef('anthropic', 'claude'), modelRef('anthropic', 'haiku')]);
    expect(pickDefaultAdvisorModels(catalog(), modelLists(), 1)).toEqual([modelRef('anthropic', 'claude')]);
  });

  test('a favorite that is also a recent, or listed twice, is picked once', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('openai', 'gpt')],
      recentModels: [modelRef('openai', 'gpt'), modelRef('openai', 'o3')],
    }))).toEqual([modelRef('openai', 'gpt'), modelRef('openai', 'o3')]);
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('openai', 'gpt'), modelRef('openai', 'gpt')],
    }))).toEqual([modelRef('openai', 'gpt'), modelRef('anthropic', 'claude')]);
  });

  test('returns fewer than count when that is all that is usable, including none', () => {
    expect(pickDefaultAdvisorModels([catalogProvider('anthropic', ['claude'])], modelLists()))
      .toEqual([modelRef('anthropic', 'claude')]);
    expect(pickDefaultAdvisorModels([], modelLists())).toEqual([]);
  });

  test('references that no longer resolve are skipped', () => {
    expect(pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('ghost', 'phantom'), modelRef('anthropic', 'missing')],
      recentModels: [modelRef('openai', 'gpt')],
    }))).toEqual([modelRef('openai', 'gpt'), modelRef('anthropic', 'claude')]);
  });

  test('equal inputs always give the same pair', () => {
    const first = pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('anthropic', 'claude')],
      recentModels: [modelRef('openai', 'gpt')],
    }));
    const second = pickDefaultAdvisorModels(catalog(), modelLists({
      favoriteModels: [modelRef('anthropic', 'claude')],
      recentModels: [modelRef('openai', 'gpt')],
    }));
    expect(first).toEqual([modelRef('anthropic', 'claude'), modelRef('openai', 'gpt')]);
    expect(second).toEqual(first);
  });
});
