import React, { act } from 'react';
import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

// React detects input-event support when its DOM renderer is first imported.
// Give that probe a document, then restore the caller's globals immediately.
const rendererWindow = new Window();
const rendererGlobals = ['window', 'document'] as const;
const previousRendererGlobals = rendererGlobals.map((name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const);
Object.defineProperty(globalThis, 'window', { value: rendererWindow, configurable: true, writable: true });
Object.defineProperty(globalThis, 'document', { value: rendererWindow.document, configurable: true, writable: true });
const { createRoot } = await import('react-dom/client');
for (const [name, descriptor] of previousRendererGlobals) {
  if (descriptor) Object.defineProperty(globalThis, name, descriptor);
  else Reflect.deleteProperty(globalThis, name);
}
rendererWindow.close();

const { NewWorktreeBranchPicker } = await import('./NewWorktreeBranchPicker');
const { I18nProvider } = await import('@/lib/i18n');

const DOM_GLOBAL_NAMES = [
  'window',
  'document',
  'navigator',
  'Node',
  'Element',
  'HTMLElement',
  'HTMLInputElement',
  'KeyboardEvent',
  'MouseEvent',
  'Event',
  'localStorage',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

const SEARCH_PLACEHOLDER = 'Search branches...';

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  const previous = DOM_GLOBAL_NAMES.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const values = {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
    Node: happyWindow.Node,
    Element: happyWindow.Element,
    HTMLElement: happyWindow.HTMLElement,
    HTMLInputElement: happyWindow.HTMLInputElement,
    KeyboardEvent: happyWindow.KeyboardEvent,
    MouseEvent: happyWindow.MouseEvent,
    Event: happyWindow.Event,
    localStorage: happyWindow.localStorage,
    requestAnimationFrame: happyWindow.requestAnimationFrame.bind(happyWindow),
    cancelAnimationFrame: happyWindow.cancelAnimationFrame.bind(happyWindow),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_GLOBAL_NAMES) {
    Object.defineProperty(globalThis, name, { value: values[name], configurable: true, writable: true });
  }

  const container = document.createElement('div');
  document.body.appendChild(container);
  return {
    container,
    restore: () => {
      happyWindow.close();
      for (const [name, descriptor] of previous) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
};

describe('NewWorktreeBranchPicker behavior', () => {
  test('the mobile sheet puts the caret in the branch search field', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeBranchPicker
            value=""
            placeholder="Choose a branch…"
            title="Based on"
            localBranches={['main', 'feature/one']}
            remoteBranches={['main']}
            isLoading={false}
            isMobile
            onSelect={() => undefined}
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('button');
      if (!trigger) throw new Error('Missing branch trigger');

      // The sheet raises its open signal from a layout effect, and the search
      // field commits before it. Catching the field already focused there
      // proves the focus landed in the opening commit, not in a later task —
      // a deferred focus does not raise the keyboard in an installed iOS PWA.
      let focusedAtOpenSignal: string | null | undefined;
      const onOverlayOpened = () => {
        focusedAtOpenSignal = document.activeElement?.getAttribute('placeholder');
      };
      window.addEventListener('oc:mobile-overlay-opened', onOverlayOpened);
      await act(async () => trigger.click());
      window.removeEventListener('oc:mobile-overlay-opened', onOverlayOpened);
      expect(focusedAtOpenSignal).toBe(SEARCH_PLACEHOLDER);

      // The sheet renders into the shared mobile overlay root, not the picker.
      const search = document.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
      if (!search) throw new Error('Missing branch search input');
      // Compared as text, not as DOM nodes: matching two DOM nodes with
      // expect(...).toBe(...) never returns when they differ.
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
      expect(document.activeElement === search).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('reopening the mobile sheet focuses the search field again and drops the old query', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeBranchPicker
            value=""
            placeholder="Choose a branch…"
            title="Based on"
            localBranches={['main', 'feature/one']}
            remoteBranches={['main']}
            isLoading={false}
            isMobile
            onSelect={() => undefined}
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('button');
      if (!trigger) throw new Error('Missing branch trigger');
      await act(async () => trigger.click());

      const first = document.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
      if (!first) throw new Error('Missing branch search input');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('Missing input value setter');
      await act(async () => {
        setValue.call(first, 'feature');
        first.dispatchEvent(new Event('input', { bubbles: true }));
      });
      expect(first.value).toBe('feature');

      // Closing the sheet clears the query; the sheet unmounts with it.
      const close = document.querySelector<HTMLButtonElement>('button[aria-label="Close"]');
      if (!close) throw new Error('Missing sheet close button');
      await act(async () => close.click());
      expect(document.querySelector(`input[placeholder="${SEARCH_PLACEHOLDER}"]`) === null).toBe(true);

      await act(async () => trigger.click());

      const second = document.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
      if (!second) throw new Error('Missing branch search input after reopen');
      expect(second.value).toBe('');
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
      expect(document.activeElement === second).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('the loading state still focuses the search field', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeBranchPicker
            value=""
            placeholder="Choose a branch…"
            title="Based on"
            localBranches={[]}
            remoteBranches={[]}
            isLoading
            isMobile
            onSelect={() => undefined}
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('button');
      if (!trigger) throw new Error('Missing branch trigger');
      await act(async () => trigger.click());

      expect(document.body.textContent).toContain('Loading branches...');
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('typing filters the list and keeps the caret in the search field', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <NewWorktreeBranchPicker
            value=""
            placeholder="Choose a branch…"
            title="Based on"
            localBranches={['main', 'feature/one']}
            remoteBranches={['main']}
            isLoading={false}
            isMobile
            onSelect={() => undefined}
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('button');
      if (!trigger) throw new Error('Missing branch trigger');
      await act(async () => trigger.click());

      const search = document.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
      if (!search) throw new Error('Missing branch search input');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('Missing input value setter');
      await act(async () => {
        setValue.call(search, 'feature');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });

      // The list narrows to the matching branch while the caret stays put.
      expect(document.body.textContent).toContain('Matching branches');
      const branchLabels = [...document.querySelectorAll('button')].map((button) => button.textContent?.trim() ?? '');
      expect(branchLabels).toContain('feature/one');
      expect(branchLabels.some((label) => label === 'main')).toBe(false);
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
      expect(document.activeElement === search).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
