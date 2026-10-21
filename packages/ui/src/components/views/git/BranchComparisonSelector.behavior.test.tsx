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

const { BranchComparisonSelector } = await import('./BranchComparisonSelector');
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
  'getComputedStyle',
  'MutationObserver',
  'ResizeObserver',
  'requestAnimationFrame',
  'cancelAnimationFrame',
  'IS_REACT_ACT_ENVIRONMENT',
] as const;

/** A phone-sized viewport: a tablet-sized one would keep the dropdown path. */
const PHONE_VIEWPORT = { width: 390, height: 844 };

const installDom = () => {
  const happyWindow = new Window({ url: 'http://localhost' });
  happyWindow.innerWidth = PHONE_VIEWPORT.width;
  happyWindow.innerHeight = PHONE_VIEWPORT.height;
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
    getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    MutationObserver: happyWindow.MutationObserver,
    ResizeObserver: happyWindow.ResizeObserver,
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

describe('BranchComparisonSelector behavior', () => {
  test('the mobile sheet puts the caret in the branch search field', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <BranchComparisonSelector
            branches={['main', 'feature/one']}
            currentBranch="main"
            base={null}
            onSelect={() => undefined}
            mobile
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('[data-mobile-comparison-trigger]');
      if (!trigger) throw new Error('Missing comparison trigger');

      // The sheet raises its open signal from a layout effect, and the search
      // field commits before it. Catching the field already focused there
      // proves the focus landed in the opening commit, not in a later task —
      // a deferred focus does not raise the keyboard in an installed iOS PWA.
      let focusedAtOpenSignal: string | null | undefined;
      const onOverlayOpened = () => {
        focusedAtOpenSignal = document.activeElement?.getAttribute('data-slot');
      };
      window.addEventListener('oc:mobile-overlay-opened', onOverlayOpened);
      await act(async () => trigger.click());
      window.removeEventListener('oc:mobile-overlay-opened', onOverlayOpened);
      expect(focusedAtOpenSignal).toBe('command-input');

      // The sheet renders into the shared mobile overlay root, not the picker.
      const search = document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
      if (!search) throw new Error('Missing branch search input');
      // Compared as text, not as DOM nodes: matching two DOM nodes with
      // expect(...).toBe(...) never returns when they differ.
      expect(document.activeElement?.getAttribute('data-slot')).toBe('command-input');
      expect(document.activeElement === search).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });

  test('typing filters the branch list while the caret stays in the search field', async () => {
    const dom = installDom();
    const root = createRoot(dom.container);
    try {
      await act(async () => root.render(
        <I18nProvider>
          <BranchComparisonSelector
            branches={['main', 'feature/one', 'zeta/two']}
            currentBranch="main"
            base={null}
            onSelect={() => undefined}
            mobile
          />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('[data-mobile-comparison-trigger]');
      if (!trigger) throw new Error('Missing comparison trigger');
      await act(async () => trigger.click());

      const search = document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
      if (!search) throw new Error('Missing branch search input');
      const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      if (!setValue) throw new Error('Missing input value setter');
      await act(async () => {
        setValue.call(search, 'one');
        search.dispatchEvent(new Event('input', { bubbles: true }));
      });

      const options = [...document.querySelectorAll('[cmdk-item]')].map((item) => item.textContent?.trim() ?? '');
      expect(options).toContain('feature/one');
      expect(options.some((option) => option === 'zeta/two')).toBe(false);
      expect(document.activeElement?.getAttribute('data-slot')).toBe('command-input');
      expect(document.activeElement === search).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
