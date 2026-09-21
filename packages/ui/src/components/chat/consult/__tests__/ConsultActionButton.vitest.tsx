import React, { act } from 'react';
import { expect, test } from 'bun:test';

import { installConsultTestDom } from './consultTestDom';

/**
 * Consult Models composer action (WP2.2).
 *
 * The action is always visible; when it cannot run, the control is disabled
 * and the tooltip (and the accessible name) explains why. A busy session is
 * not a disabled state, which the availability resolver owns.
 */

const renderAction = async (unavailableReason: 'unsupported-runtime' | 'btw-active' | null) => {
  const restoreDom = installConsultTestDom();
  const { createRoot } = await import('react-dom/client');
  const { I18nProvider } = await import('@/lib/i18n');
  const { ConsultActionButton } = await import('../ConsultActionButton');

  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let opens = 0;

  await act(async () => {
    root.render(
      <I18nProvider>
        <ConsultActionButton
          footerIconButtonClass="size-6"
          iconSizeClass="size-4"
          onOpenConsult={() => { opens += 1; }}
          unavailableReason={unavailableReason}
        />
      </I18nProvider>,
    );
  });

  const button = container.querySelector('button');
  if (!button) throw new Error('Expected the consult action button');

  return {
    container,
    button,
    opens: () => opens,
    cleanup: async () => {
      await act(async () => root.unmount());
      restoreDom();
    },
  };
};

test('opens the dialog when the action is available', async () => {
  const view = await renderAction(null);
  try {
    expect(view.button.hasAttribute('disabled')).toBe(false);
    expect(view.button.getAttribute('aria-label')).toBe('Consult models');

    await act(async () => { view.button.click(); });
    expect(view.opens()).toBe(1);
  } finally {
    await view.cleanup();
  }
});

test('disables with the explanatory reason on a runtime without the queue', async () => {
  const view = await renderAction('unsupported-runtime');
  try {
    expect(view.button.hasAttribute('disabled')).toBe(true);
    expect(view.button.getAttribute('aria-label')).toBe(
      'Consult models — Consult models needs the OpenChamber server message queue and is unavailable here',
    );

    await act(async () => { view.button.click(); });
    expect(view.opens()).toBe(0);
  } finally {
    await view.cleanup();
  }
});

test('disables while a btw session is active', async () => {
  const view = await renderAction('btw-active');
  try {
    expect(view.button.hasAttribute('disabled')).toBe(true);
    expect(view.button.getAttribute('aria-label')).toBe(
      'Consult models — Consult models is unavailable while a btw session is active',
    );
  } finally {
    await view.cleanup();
  }
});
