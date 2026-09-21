import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { QueuedMessage } from '@/stores/messageQueueStore';

/**
 * The queued chip must be consult-aware: a consult item can only be sent by
 * its own claim → dispatch route, so the chip shows a consult badge and no
 * Edit/Send buttons while manual removal stays available. Normal items keep
 * the full chip.
 */
describe('queued message chips consult affordance', () => {
  let root: Root;
  let host: HTMLDivElement;
  let restoreGlobals: () => void;
  let chunks: Array<() => void>;

  beforeEach(async () => {
    const dom = new Window();
    const globals = {
      window: dom,
      document: dom.document,
      Event: dom.Event,
      IS_REACT_ACT_ENVIRONMENT: true,
    };
    const descriptors = Object.getOwnPropertyDescriptors(globalThis);
    Object.assign(globalThis, globals);
    // SAFETY: only the four DOM globals above were replaced; restoring the
    // captured descriptors undoes exactly those assignments.
    restoreGlobals = () => {
      for (const key of Object.keys(globals)) {
        const descriptor = descriptors[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else Reflect.deleteProperty(globalThis, key);
      }
    };
    chunks = [];
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    for (const restore of chunks) restore();
    host.remove();
    restoreGlobals();
  });

  const consultMessage: QueuedMessage = {
    id: 'consult-1',
    content: 'the consult message',
    text: 'the consult message',
    createdAt: 1,
    kind: 'consult',
  };

  const normalMessage: QueuedMessage = {
    id: 'normal-1',
    content: 'a normal message',
    text: 'a normal message',
    createdAt: 2,
  };

  const buttonLabels = (): string[] => (
    [...host.querySelectorAll('button')].map((button) => button.textContent ?? '')
  );

  const renderChips = async (messages: QueuedMessage[]) => {
    const { QueuedMessageChips } = await import('../QueuedMessageChips');
    const { I18nProvider } = await import('@/lib/i18n/context');
    const { createMessageQueueTarget, getMessageQueueKey, useMessageQueueStore } = await import('@/stores/messageQueueStore');
    const { useUIStore } = await import('@/stores/useUIStore');
    const target = createMessageQueueTarget('session-1', '/repo', 'runtime-1');
    if (!target) throw new Error('target fixture failed');
    const key = getMessageQueueKey(target);
    useMessageQueueStore.setState({ queuedMessages: { [key]: messages } });
    useUIStore.setState({ messageQueueExpanded: true });
    chunks.push(() => {
      useMessageQueueStore.setState({ queuedMessages: {} });
    });

    await act(async () => {
      root.render(
        <I18nProvider>
          <QueuedMessageChips
            target={target}
            onEditMessage={() => undefined}
            onSendMessage={() => undefined}
          />
        </I18nProvider>,
      );
    });
  };

  test('a consult chip shows the badge and hides Edit/Send, keeping remove', async () => {
    await renderChips([consultMessage]);

    expect(host.textContent).toContain('Consult models');
    expect(host.textContent).toContain('the consult message');
    // Edit and Send are text buttons; the badge is plain text, not a button.
    const labels = buttonLabels();
    expect(labels.some((label) => label.includes('edit'))).toBe(false);
    expect(labels.some((label) => label.includes('send'))).toBe(false);
    // The remove control stays (manual removal is the only queue action).
    const removeButton = [...host.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === 'Remove from queue');
    expect(removeButton?.getAttribute('aria-label')).toBe('Remove from queue');
  });

  test('a normal chip keeps Edit and Send', async () => {
    await renderChips([normalMessage]);

    const labels = buttonLabels();
    expect(labels.some((label) => label.includes('edit'))).toBe(true);
    expect(labels.some((label) => label.includes('send'))).toBe(true);
    expect(host.textContent).not.toContain('Consult models');
  });
});
