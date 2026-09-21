import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { ConsultMechanismCapability } from '@/lib/consult/capability';
import type { ConsultAdvisorRejection, ConsultAdvisorSelection } from '@/lib/consult/routing';
import { formatMessage, type I18nKey, type I18nParams } from '@/lib/i18n';
import { dict as deDict } from '@/lib/i18n/messages/de';
import { dict as enDict } from '@/lib/i18n/messages/en';
import { dict as esDict } from '@/lib/i18n/messages/es';
import { dict as frDict } from '@/lib/i18n/messages/fr';
import { dict as jaDict } from '@/lib/i18n/messages/ja';
import { dict as koDict } from '@/lib/i18n/messages/ko';
import { dict as plDict } from '@/lib/i18n/messages/pl';
import { dict as ptBrDict } from '@/lib/i18n/messages/pt-BR';
import { dict as trDict } from '@/lib/i18n/messages/tr';
import { dict as ukDict } from '@/lib/i18n/messages/uk';
import { dict as zhCnDict } from '@/lib/i18n/messages/zh-CN';
import { dict as zhTwDict } from '@/lib/i18n/messages/zh-TW';
import type { ConsultAdvisorRunStatus, ConsultRunPhase } from '@/stores/useConsultStore';
import type { ConsultAvailabilityInput, ConsultUnavailableReason } from '../consultUi';

/**
 * The resolver consumes `resolveConsultMechanismCapability()`, so the test owns
 * both capability branches at that seam. The mock is registered before
 * `consultUi` is imported, hence the dynamic import below.
 */
let mechanismCapability: ConsultMechanismCapability = { available: true, assurance: 'unverified' };

mock.module('@/lib/consult/capability', () => ({
  resolveConsultMechanismCapability: (): ConsultMechanismCapability => mechanismCapability,
  // The hook under test resolves the live gate through this seam; the
  // presentation tests only need it to settle to the current mock answer.
  resolveConsultLiveCapability: async (): Promise<ConsultMechanismCapability> => mechanismCapability,
  CONSULT_MIN_OPENCODE_VERSION: '1.18.29',
}));

const {
  consultCaptureDisposition,
  initialConsultCapability,
  consultStatusLabelKey,
  consultStatusPresentation,
  consultUnavailableLabelKey,
  formatConsultDuration,
  formatConsultRejections,
  isConsultRunCancellable,
  isConsultRunTerminal,
  isDeliveredRawSubmission,
  resolveConsultAvailability,
} = await import('../consultUi');

const t = (key: I18nKey, params?: I18nParams): string => formatMessage(enDict, key, params);

const availableInput: ConsultAvailabilityInput = {
  hasSession: true,
  input: 'explain this module',
  shellMode: false,
  btwActive: false,
  consultActive: false,
  autoReviewActive: false,
};

const localeDictionaries = {
  en: enDict,
  de: deDict,
  es: esDict,
  fr: frDict,
  ja: jaDict,
  ko: koDict,
  pl: plDict,
  'pt-BR': ptBrDict,
  tr: trDict,
  uk: ukDict,
  'zh-CN': zhCnDict,
  'zh-TW': zhTwDict,
} as const;

const AUTO_REVIEW_LABEL_KEY = 'chat.consult.unavailable.autoReview' as const;

/**
 * Every locale dictionary carries the same key domain as English (parity is
 * asserted by `messages.test.ts`), so this typed reader lets the locale loops
 * index by a known key without assertions and still answers `undefined` when a
 * key is genuinely absent.
 */
const readLocaleKey = (dictionary: Partial<Record<I18nKey, string>>, key: I18nKey): string | undefined =>
  dictionary[key];

describe('resolveConsultAvailability', () => {
  beforeEach(() => {
    mechanismCapability = { available: true, assurance: 'unverified' };
  });

  test('is available in the plain composer state', () => {
    expect(resolveConsultAvailability(availableInput)).toEqual({ available: true });
  });

  test('consumes the mechanism capability for the runtime gate', () => {
    // `unsupported-runtime` is the only capability answer that disables the
    // action; `assurance: 'unverified'` must not add a stricter gate.
    mechanismCapability = { available: false, reason: 'unsupported-runtime' };
    expect(resolveConsultAvailability(availableInput)).toEqual({
      available: false,
      reason: 'unsupported-runtime',
    });

    mechanismCapability = { available: true, assurance: 'unverified' };
    expect(resolveConsultAvailability(availableInput)).toEqual({ available: true });
  });

  test('consumes the live capability when the caller provides it (F3)', () => {
    // The composed live gate (runtime + OpenCode version) replaces the sync
    // runtime gate when the caller resolved it.
    expect(resolveConsultAvailability({
      ...availableInput,
      mechanism: { available: true, assurance: 'verified', version: '1.18.31' },
    })).toEqual({ available: true });
    expect(resolveConsultAvailability({
      ...availableInput,
      mechanism: { available: false, reason: 'version-unknown' },
    })).toEqual({ available: false, reason: 'version-unknown' });
    expect(resolveConsultAvailability({
      ...availableInput,
      mechanism: { available: false, reason: 'version-unsupported', version: '1.18.28' },
    })).toEqual({ available: false, reason: 'version-unsupported' });
    // The runtime gate still wins over a live answer when it is unsupported.
    expect(resolveConsultAvailability({
      ...availableInput,
      mechanism: { available: false, reason: 'unsupported-runtime' },
    })).toEqual({ available: false, reason: 'unsupported-runtime' });
    // Fundamental composer reasons come after the capability gates.
    expect(resolveConsultAvailability({
      ...availableInput,
      hasSession: false,
      mechanism: { available: false, reason: 'version-unknown' },
    })).toEqual({ available: false, reason: 'no-session' });
  });

  test('a busy session is not an unavailability state', () => {
    // There is deliberately no session-activity field: the consult is admitted
    // through the server-authoritative queue, so a busy parent is covered by
    // the submission's waiting-admission phase and the action stays enabled.
    // This test pins that contract against a future "disable while busy".
    expect(resolveConsultAvailability({ ...availableInput })).toEqual({ available: true });
  });

  const unavailableCases: ReadonlyArray<[string, Partial<ConsultAvailabilityInput>, ConsultUnavailableReason]> = [
    ['no session', { hasSession: false }, 'no-session'],
    ['an active consult', { consultActive: true }, 'consult-active'],
    ['an active auto-review', { autoReviewActive: true }, 'auto-review-active'],
    ['an active btw session', { btwActive: true }, 'btw-active'],
    ['shell mode', { shellMode: true }, 'shell-command'],
    ['a slash command', { input: '/compact' }, 'slash-command'],
    ['a slash command after leading whitespace', { input: '  /btw hello' }, 'slash-command'],
  ];

  for (const [label, override, reason] of unavailableCases) {
    test(`is unavailable for ${label}`, () => {
      expect(resolveConsultAvailability({ ...availableInput, ...override })).toEqual({
        available: false,
        reason,
      });
    });
  }

  test('reports the most fundamental reason first', () => {
    expect(resolveConsultAvailability({ ...availableInput, hasSession: false }))
      .toEqual({ available: false, reason: 'no-session' });

    mechanismCapability = { available: false, reason: 'unsupported-runtime' };
    expect(resolveConsultAvailability({ ...availableInput, input: '/x' }))
      .toEqual({ available: false, reason: 'unsupported-runtime' });

    mechanismCapability = { available: true, assurance: 'unverified' };
    expect(resolveConsultAvailability({ ...availableInput, consultActive: true, btwActive: true }))
      .toEqual({ available: false, reason: 'consult-active' });
    // Auto-review sits next to consult-active: a consult already owned by the
    // run wins, and auto-review wins over the remaining composer states.
    expect(resolveConsultAvailability({ ...availableInput, consultActive: true, autoReviewActive: true }))
      .toEqual({ available: false, reason: 'consult-active' });
    expect(resolveConsultAvailability({ ...availableInput, autoReviewActive: true, btwActive: true }))
      .toEqual({ available: false, reason: 'auto-review-active' });
  });
});

describe('live capability initial state (WP-4)', () => {
  test('a server-queue runtime starts fail-closed at checking-version', () => {
    // Never `assurance: 'unverified'`: the action is disabled until the
    // version read settles.
    expect(initialConsultCapability({ available: true, assurance: 'unverified' }))
      .toEqual({ available: false, reason: 'checking-version' });
    expect(initialConsultCapability({ available: true, assurance: 'verified', version: '1.18.31' }))
      .toEqual({ available: false, reason: 'checking-version' });
    // The default reads the mocked runtime gate (server-queue capable).
    expect(initialConsultCapability()).toEqual({ available: false, reason: 'checking-version' });
  });

  test('a runtime-gate refusal wins over the checking state', () => {
    expect(initialConsultCapability({ available: false, reason: 'unsupported-runtime' }))
      .toEqual({ available: false, reason: 'unsupported-runtime' });
  });
});

describe('consult UI labels', () => {
  const reasons: readonly ConsultUnavailableReason[] = [
    'no-session',
    'unsupported-runtime',
    'checking-version',
    'version-unknown',
    'version-unsupported',
    'consult-active',
    'auto-review-active',
    'btw-active',
    'shell-command',
    'slash-command',
  ];

  test('every unavailable reason maps to a distinct English string', () => {
    const labels = reasons.map((reason) => enDict[consultUnavailableLabelKey(reason)]);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    expect(new Set(labels).size).toBe(reasons.length);
  });

  const statuses: readonly ConsultAdvisorRunStatus[] = [
    'queued',
    'running',
    'ok',
    'failed',
    'timeout',
    'empty',
    'cancelled',
  ];

  test('every advisor status has a label and a presentation', () => {
    const labels = statuses.map((status) => enDict[consultStatusLabelKey(status)]);
    expect(labels.every((label) => label.length > 0)).toBe(true);
    for (const status of statuses) {
      const presentation = consultStatusPresentation(status);
      expect(presentation.icon.length).toBeGreaterThan(0);
      expect(presentation.className.length).toBeGreaterThan(0);
    }
  });

  test('the running status is the only animated one', () => {
    for (const status of statuses) {
      expect(consultStatusPresentation(status).className.includes('animate-spin')).toBe(status === 'running');
    }
  });
});

describe('consult unavailable reason localization', () => {
  test('the auto-review reason is translated in every locale', () => {
    expect(consultUnavailableLabelKey('auto-review-active')).toBe(AUTO_REVIEW_LABEL_KEY);
    for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
      const label = dictionary[AUTO_REVIEW_LABEL_KEY];
      expect(label.length).toBeGreaterThan(0);
      // No English placeholder may ship in a non-English dictionary.
      if (locale !== 'en') expect(label).not.toBe(enDict[AUTO_REVIEW_LABEL_KEY]);
    }
  });

  test('the version reasons are translated in every locale (F3)', () => {
    for (const key of ['chat.consult.panel.ready', 'chat.consult.summary.segment', 'chat.consult.unavailable.checkingVersion', 'chat.consult.unavailable.versionUnknown', 'chat.consult.unavailable.versionUnsupported'] as const) {
      for (const dictionary of Object.values(localeDictionaries)) {
        const label = readLocaleKey(dictionary, key);
        expect(label?.length ?? 0).toBeGreaterThan(0);
      }
    }
    // Prose keys must not ship the English placeholder. `summary.segment` is
    // deliberately placeholder-only in every locale (the status label inside
    // it is what gets translated), so it is covered by presence alone.
    for (const key of ['chat.consult.panel.ready', 'chat.consult.unavailable.checkingVersion', 'chat.consult.unavailable.versionUnknown', 'chat.consult.unavailable.versionUnsupported'] as const) {
      for (const [locale, dictionary] of Object.entries(localeDictionaries)) {
        if (locale === 'en') continue;
        expect(readLocaleKey(dictionary, key)).not.toBe(enDict[key]);
      }
    }
    // Both strings name the version placeholder, which the action button
    // fills with the verified floor.
    expect(enDict['chat.consult.unavailable.versionUnknown']).toContain('{version}');
    expect(enDict['chat.consult.unavailable.versionUnsupported']).toContain('{minVersion}');
    expect(enDict['chat.consult.panel.ready']).toBe('{ready} / {total} ready');
    expect(enDict['chat.consult.summary.segment']).toBe('{count} {status}');
  });
});

describe('consult run phases', () => {
  const phases: readonly ConsultRunPhase[] = [
    'idle',
    'waiting-admission',
    'consulting',
    'settling',
    'dispatching',
    'done',
    'failed',
    'cancelled',
  ];

  test('cancel is offered only before the acting dispatch', () => {
    for (const phase of phases) {
      expect(isConsultRunCancellable(phase)).toBe(
        phase === 'waiting-admission' || phase === 'consulting' || phase === 'settling',
      );
    }
  });

  test('terminal phases are done, failed, and cancelled', () => {
    for (const phase of phases) {
      expect(isConsultRunTerminal(phase)).toBe(
        phase === 'done' || phase === 'failed' || phase === 'cancelled',
      );
    }
  });
});

describe('submission outcomes', () => {
  test('delivered-raw is recognized on its own', () => {
    // The core result union is being widened with this status; the composer
    // must keep the branch even before the union carries it.
    expect(isDeliveredRawSubmission('delivered-raw')).toBe(true);
    expect(isDeliveredRawSubmission('dispatched')).toBe(false);
    expect(isDeliveredRawSubmission('cancelled')).toBe(false);
    expect(isDeliveredRawSubmission('refused')).toBe(false);
    expect(isDeliveredRawSubmission('failed')).toBe(false);
  });
});

describe('consultCaptureDisposition', () => {
  test('restores only when nothing was delivered or re-queued', () => {
    // Cancelled: nothing was sent and nothing was re-queued.
    expect(consultCaptureDisposition({ status: 'cancelled' })).toBe('restore');
    // Delivered raw: may already have been sent, so restoring could send it twice.
    expect(consultCaptureDisposition({ status: 'delivered-raw', queueItemRestored: false })).toBe('keep');
    // A restored queue item is delivered normally.
    expect(consultCaptureDisposition({ status: 'refused', queueItemRestored: true })).toBe('keep');
    expect(consultCaptureDisposition({ status: 'failed', queueItemRestored: true })).toBe('keep');
    // An unrestored refusal/failure gives the payload back to the composer.
    expect(consultCaptureDisposition({ status: 'refused', queueItemRestored: false })).toBe('restore');
    expect(consultCaptureDisposition({ status: 'failed', queueItemRestored: false })).toBe('restore');
    // An uncertain failure keeps the capture cleared like delivered-raw: the
    // dispatch outcome is unconfirmed, so restoring could send it twice.
    expect(consultCaptureDisposition({ status: 'failed', queueItemRestored: false, uncertain: true })).toBe('keep');
    expect(consultCaptureDisposition({ status: 'failed', queueItemRestored: true, uncertain: true })).toBe('keep');
  });
});

describe('formatConsultRejections', () => {
  const advisors: readonly ConsultAdvisorSelection[] = [
    { providerID: 'openai', modelID: 'gpt-5.5', variant: 'high', agent: 'build' },
    { providerID: 'anthropic', modelID: 'claude-sonnet-4', agent: 'plan' },
  ];

  const rejection = (index: number, code: ConsultAdvisorRejection['code']): ConsultAdvisorRejection => ({
    index,
    code,
    message: 'the English runtime message is not the toast copy',
  });

  test('renders nothing when nothing was rejected', () => {
    expect(formatConsultRejections(t, [], advisors)).toBeNull();
  });

  test('names each rejected advisor with its localized reason', () => {
    const lines = formatConsultRejections(t, [
      rejection(0, 'provider-unknown'),
      rejection(1, 'model-unknown'),
      rejection(0, 'variant-unknown'),
      rejection(1, 'agent-unknown'),
      rejection(1, 'agent-not-primary'),
    ], advisors);

    expect(lines).toEqual([
      'Advisor 1: provider "openai" is not available',
      'Advisor 2: model "anthropic/claude-sonnet-4" is not available',
      'Advisor 1: variant "high" is not available for "openai/gpt-5.5"',
      'Advisor 2: agent "plan" is not available',
      'Advisor 2: agent "plan" is not a primary agent',
    ]);
  });

  test('falls back to a generic line for an index without a selection', () => {
    const lines = formatConsultRejections(t, [rejection(7, 'model-unknown')], advisors);
    expect(lines).toEqual(['Advisor 8: this selection is not available']);
  });

  test('every rejection code maps to a distinct localized message', () => {
    const codes: ReadonlyArray<ConsultAdvisorRejection['code']> = [
      'provider-unknown',
      'model-unknown',
      'variant-unknown',
      'agent-unknown',
      'agent-not-primary',
    ];
    const lines = codes.map((code) =>
      formatConsultRejections(t, [rejection(0, code)], advisors)?.[0] ?? '');
    expect(lines.every((line) => line.length > 0)).toBe(true);
    expect(new Set(lines).size).toBe(codes.length);
  });
});

describe('formatConsultDuration', () => {
  test('renders whole seconds from milliseconds', () => {
    expect(formatConsultDuration(t, 120_000)).toBe('120 s');
    expect(formatConsultDuration(t, 12_400)).toBe('12 s');
    expect(formatConsultDuration(t, 600)).toBe('1 s');
    expect(formatConsultDuration(t, 0)).toBe('0 s');
  });

  test('renders nothing without a duration', () => {
    expect(formatConsultDuration(t, undefined)).toBeNull();
  });
});
