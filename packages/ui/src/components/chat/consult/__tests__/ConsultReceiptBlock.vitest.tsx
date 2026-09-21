import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { TextPart } from '@opencode-ai/sdk/v2/client';

import { CONSULT_RECEIPT_METADATA_KEY, type ConsultReceipt } from '@/lib/consult/synthesis';
import { installConsultTestDom } from './consultTestDom';

/**
 * Consult Models receipt (WP2.3).
 *
 * The receipt is read back from the acting user message's text-part metadata,
 * so these tests drive the exact read boundary `UserTextPart` uses: a valid
 * carrier renders the compact block, and anything missing or malformed renders
 * nothing instead of breaking the timeline.
 */

const receipt: ConsultReceipt = {
  runID: 'run-1',
  at: 1_700_000_000_000,
  mode: 'parallel',
  acting: 'openai/gpt-5.5',
  advisors: [
    { model: 'anthropic/claude-sonnet-4', status: 'ok', durationMs: 9_000 },
    { model: 'google/gemini-2.5', status: 'failed', durationMs: 1_500, reason: 'Provider error' },
  ],
  degraded: false,
};

const renderReceiptPart = async (metadata: TextPart['metadata'] | null | undefined) => {
  const restoreDom = installConsultTestDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ConsultReceiptFromPart } = await import('../ConsultReceiptBlock');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <I18nProvider>
        {/* The part boundary hands the component its metadata object. */}
        <ConsultReceiptFromPart metadata={metadata} />
      </I18nProvider>,
    );
  });
  return {
    container,
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreDom();
    },
  };
};

test('renders the compact receipt carried by a text part', async () => {
  const view = await renderReceiptPart({ [CONSULT_RECEIPT_METADATA_KEY]: receipt });
  try {
    const block = view.container.querySelector('[data-consult-receipt="run-1"]');
    expect(block).not.toBeNull();
    expect(view.container.textContent).toContain('Consulted 2 models');
    expect(view.container.textContent).toContain('Parallel');
    expect(view.container.textContent).toContain('Acting: openai/gpt-5.5');
    expect(view.container.textContent).toContain('anthropic/claude-sonnet-4');
    expect(view.container.textContent).toContain('Answered');
    expect(view.container.textContent).toContain('9 s');
    expect(view.container.textContent).toContain('Failed');
    expect(view.container.textContent).toContain('Provider error');
  } finally {
    await view.cleanup();
  }
});

test('renders the degraded marker when no advisor produced output', async () => {
  const degraded: ConsultReceipt = {
    ...receipt,
    degraded: true,
    advisors: [{ model: 'google/gemini-2.5', status: 'timeout', durationMs: 120_000 }],
  };
  const view = await renderReceiptPart({ [CONSULT_RECEIPT_METADATA_KEY]: degraded });
  try {
    expect(view.container.textContent).toContain('Consulted 1 models');
    expect(view.container.textContent).toContain('No usable advisor output');
    expect(view.container.textContent).toContain('Timed out');
  } finally {
    await view.cleanup();
  }
});

test('renders nothing without a receipt in the metadata', async () => {
  const view = await renderReceiptPart(null);
  try {
    expect(view.container.querySelector('[data-consult-receipt]')).toBeNull();
    expect(view.container.textContent).toBe('');
  } finally {
    await view.cleanup();
  }
});

test('renders nothing for malformed or foreign metadata', async () => {
  const malformed = await renderReceiptPart({ [CONSULT_RECEIPT_METADATA_KEY]: { runID: 'run-1' } });
  try {
    expect(malformed.container.querySelector('[data-consult-receipt]')).toBeNull();
    expect(malformed.container.textContent).toBe('');
  } finally {
    await malformed.cleanup();
  }

  const foreign = await renderReceiptPart({ openchamberContext: { kind: 'github-issue' } });
  try {
    expect(foreign.container.querySelector('[data-consult-receipt]')).toBeNull();
    expect(foreign.container.textContent).toBe('');
  } finally {
    await foreign.cleanup();
  }
});

test('UserTextPart renders the receipt boundary on its text part', () => {
  const source = readFileSync(new URL('../../message/parts/UserTextPart.tsx', import.meta.url), 'utf8');
  expect(source).toContain('<ConsultReceiptFromPart metadata={part.type === \'text\' ? part.metadata : null} />');
});
