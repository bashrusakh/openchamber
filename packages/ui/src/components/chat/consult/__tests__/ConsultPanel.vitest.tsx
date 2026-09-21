import React, { act } from 'react';
import { expect, test } from 'bun:test';

import type {
  ConsultAdvisorProgress,
  ConsultAdvisorRunStatus,
  ConsultRunProgress,
} from '@/stores/useConsultStore';
import { installConsultTestDom } from './consultTestDom';

/**
 * Consult Models progress panel (WP2.3).
 *
 * The panel is a pure render of `useConsultStore` plus two callbacks, so these
 * tests drive it with explicit run records: the queue-admission phase, every
 * advisor status, and the cancel/dismiss split before and after dispatch.
 */

const advisor = (
  index: number,
  status: ConsultAdvisorRunStatus,
  extra?: Partial<ConsultAdvisorProgress>,
): ConsultAdvisorProgress => ({
  index,
  providerID: index % 2 === 0 ? 'openai' : 'anthropic',
  modelID: `model-${index}`,
  agent: 'build',
  status,
  ...extra,
});

const run = (overrides: Partial<ConsultRunProgress>): ConsultRunProgress => ({
  runId: 'run-1',
  phase: 'waiting-admission',
  mode: 'parallel',
  timeoutMs: 120_000,
  advisors: [advisor(0, 'queued'), advisor(1, 'queued')],
  degraded: false,
  ...overrides,
});

const renderPanel = async (panelRun: ConsultRunProgress) => {
  const restoreDom = installConsultTestDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ConsultPanel } = await import('../ConsultPanel');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let cancels = 0;
  let dismissals = 0;

  await act(async () => {
    root.render(
      <I18nProvider>
        <ConsultPanel
          run={panelRun}
          onCancel={() => { cancels += 1; }}
          onDismiss={() => { dismissals += 1; }}
        />
      </I18nProvider>,
    );
  });

  return {
    container,
    cancels: () => cancels,
    dismissals: () => dismissals,
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreDom();
    },
  };
};

test('a working run shows the live ready aggregate', async () => {
  const view = await renderPanel(run({
    phase: 'consulting',
    advisors: [advisor(0, 'running'), advisor(1, 'ok'), advisor(2, 'timeout')],
  }));
  try {
    const ready = view.container.querySelector('[data-consult-ready]');
    // Ready counts advisors that are no longer queued/running, so a timeout is
    // ready too: the issue mock's running + ok + timeout run reads `2 / 3 ready`.
    expect(ready?.textContent).toBe('2 / 3 ready');
    expect(view.container.querySelector('[data-consult-summary]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test('a finished run replaces the ready line with the ordered summary and skips zero counts', async () => {
  const view = await renderPanel(run({
    phase: 'done',
    advisors: [advisor(0, 'ok'), advisor(1, 'ok'), advisor(2, 'timeout')],
  }));
  try {
    expect(view.container.querySelector('[data-consult-ready]')).toBeNull();
    const summary = view.container.querySelector('[data-consult-summary]');
    // Order is ok → timeout; failed/empty/cancelled are absent.
    expect(summary?.textContent).toBe('2 Answered · 1 Timed out');
  } finally {
    await view.cleanup();
  }
});

test('waiting for admission shows the queue state, queued rows, and a cancel action', async () => {
  const view = await renderPanel(run({ phase: 'waiting-admission' }));
  try {
    expect(view.container.querySelector('[data-consult-phase="waiting-admission"]')?.textContent)
      .toBe('Waiting for the queue and an idle session…');
    expect(view.container.textContent).toContain('Consult models');
    expect(view.container.querySelectorAll('[data-consult-advisor]')).toHaveLength(2);
    expect(view.container.textContent).toContain('Queued');
    expect(view.container.textContent).not.toContain('Answered');

    const cancel = view.container.querySelector<HTMLButtonElement>('button[aria-label="Cancel consultation"]');
    if (!cancel) throw new Error('Expected a cancel button while admission waits');
    expect(view.container.querySelector('button[aria-label="Dismiss"]')).toBeNull();

    await act(async () => { cancel.click(); });
    expect(view.cancels()).toBe(1);
    expect(view.dismissals()).toBe(0);
  } finally {
    await view.cleanup();
  }
});

test('every advisor status renders its label, duration, and reason', async () => {
  const view = await renderPanel(run({
    phase: 'consulting',
    advisors: [
      advisor(0, 'ok', { durationMs: 12_400 }),
      advisor(1, 'failed', { durationMs: 800, reason: 'Provider error' }),
      advisor(2, 'timeout', { durationMs: 120_000 }),
      advisor(3, 'empty', { durationMs: 5_000 }),
      advisor(4, 'cancelled'),
    ],
  }));
  try {
    expect(view.container.querySelector('[data-consult-phase="consulting"]')?.textContent)
      .toBe('Consulting 5 advisors…');
    expect(view.container.querySelectorAll('[data-consult-advisor]')).toHaveLength(5);
    for (const label of ['Answered', 'Failed', 'Timed out', 'No answer', 'Cancelled']) {
      expect(view.container.textContent).toContain(label);
    }
    expect(view.container.textContent).toContain('12 s');
    expect(view.container.textContent).toContain('Provider error');
    expect(view.container.querySelector('button[aria-label="Cancel consultation"]')).not.toBeNull();
  } finally {
    await view.cleanup();
  }
});

test('a finished degraded run offers dismiss and no cancel', async () => {
  const view = await renderPanel(run({
    phase: 'done',
    degraded: true,
    advisors: [advisor(0, 'failed', { durationMs: 900, reason: 'No provider' }), advisor(1, 'empty', { durationMs: 700 })],
  }));
  try {
    expect(view.container.querySelector('[data-consult-phase="done"]')?.textContent)
      .toBe('Consultation finished');
    expect(view.container.textContent).toContain('No usable advisor output; the message was sent with a notice');
    expect(view.container.querySelector('button[aria-label="Cancel consultation"]')).toBeNull();

    const dismiss = view.container.querySelector<HTMLButtonElement>('button[aria-label="Dismiss"]');
    if (!dismiss) throw new Error('Expected a dismiss button on a finished run');
    await act(async () => { dismiss.click(); });
    expect(view.dismissals()).toBe(1);
  } finally {
    await view.cleanup();
  }
});

test('dispatching shows progress but neither cancel nor dismiss', async () => {
  const view = await renderPanel(run({ phase: 'dispatching' }));
  try {
    expect(view.container.querySelector('[data-consult-phase="dispatching"]')?.textContent)
      .toBe('Sending the acting reply…');
    expect(view.container.querySelector('button[aria-label="Cancel consultation"]')).toBeNull();
    expect(view.container.querySelector('button[aria-label="Dismiss"]')).toBeNull();
  } finally {
    await view.cleanup();
  }
});

test('a failed run shows its error', async () => {
  const view = await renderPanel(run({
    phase: 'failed',
    error: 'The runtime changed before the consultation was dispatched.',
  }));
  try {
    expect(view.container.querySelector('[data-consult-phase="failed"]')?.textContent)
      .toBe('Consultation failed');
    expect(view.container.textContent).toContain('The runtime changed before the consultation was dispatched.');
  } finally {
    await view.cleanup();
  }
});
