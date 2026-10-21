import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * The desktop integrate-branch dropdown asks for the focus in its search
 * field, and Escape still closes it.
 *
 * The focus assertion is made at the moment the popup lands, and it
 * discriminates in happy-dom: Base UI's focus manager focuses the field a
 * frame later, so without the explicit request the field is not focused at
 * that moment.
 *
 * It is not a measurement of the browser's tabbable scan — happy-dom has no
 * checkVisibility(), so it cannot model the `display: contents` portal root
 * that stops the manager from reaching the field in a real browser (see
 * dropdown-menu). The assertion covers the request, not the scan.
 */
const openDesktopDropdown = async (run: (input: HTMLInputElement) => Promise<void>) => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    localStorage: dom.localStorage,
    Element: dom.Element,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Node: dom.Node,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    MutationObserver: dom.MutationObserver,
    ResizeObserver: dom.ResizeObserver,
    getComputedStyle: dom.getComputedStyle.bind(dom),
    requestAnimationFrame: dom.requestAnimationFrame.bind(dom),
    cancelAnimationFrame: dom.cancelAnimationFrame.bind(dom),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  // The section's background reads never answer here; they do not matter. The
  // stub goes in before the import, because the runtime client captures the
  // global fetch when it loads.
  const originalFetch = globalThis.fetch;
  globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), originalFetch);
  const { createRoot } = await import('react-dom/client');
  const { BranchIntegrationSection } = await import('./BranchIntegrationSection');
  const { I18nProvider } = await import('@/lib/i18n');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  let focusedWhenPopupLanded: string | null | undefined = 'never-observed';
  try {
    await act(async () => root.render(
      <I18nProvider>
        <BranchIntegrationSection
          currentBranch="main"
          localBranches={['main', 'feature/one']}
          remoteBranches={[]}
          onMerge={() => undefined}
          onRebase={() => undefined}
          mode="inline"
        />
      </I18nProvider>,
    ));
    const trigger = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .find((button) => (button.textContent ?? '').includes('Select Branch'));
    if (!trigger) throw new Error('Missing branch dropdown trigger');

    const observer = new MutationObserver(() => {
      if (!document.querySelector('input[data-slot="command-input"]')) return;
      focusedWhenPopupLanded = document.activeElement?.getAttribute('data-slot');
      observer.disconnect();
    });
    observer.observe(document.body, { childList: true, subtree: true });

    // The menu opens on mousedown.
    await act(async () => {
      const pointerInit: PointerEventInit = { bubbles: true, cancelable: true, button: 0, pointerId: 1, pointerType: 'mouse' };
      const mouseInit: MouseEventInit = { bubbles: true, cancelable: true, button: 0 };
      trigger.dispatchEvent(new window.PointerEvent('pointerdown', pointerInit));
      trigger.dispatchEvent(new window.MouseEvent('mousedown', mouseInit));
      trigger.dispatchEvent(new window.PointerEvent('pointerup', pointerInit));
      trigger.dispatchEvent(new window.MouseEvent('mouseup', mouseInit));
      trigger.dispatchEvent(new window.MouseEvent('click', mouseInit));
    });
    observer.disconnect();

    const search = document.querySelector<HTMLInputElement>('input[data-slot="command-input"]');
    if (!search) throw new Error('Missing branch search input');
    expect(focusedWhenPopupLanded).toBe('command-input');
    await run(search);
  } finally {
    globalThis.fetch = originalFetch;
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
};

test('the desktop integrate-branch dropdown asks for the focus in its search field', async () => {
  await openDesktopDropdown(async (search) => {
    // Compared as text, not as DOM nodes: matching two DOM nodes with
    // expect(...).toBe(...) never returns when they differ.
    expect(document.activeElement?.getAttribute('data-slot')).toBe('command-input');
    expect(document.activeElement === search).toBe(true);
  });
});

test('Escape closes the desktop integrate-branch dropdown while the search field holds the focus', async () => {
  await openDesktopDropdown(async (search) => {
    expect(document.activeElement === search).toBe(true);
    await act(async () => {
      search.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    });
    // Base UI closes the menu on Escape from a document-level listener, so the
    // key has to travel past the field's own handler to reach it.
    await act(async () => { await new Promise((resolve) => window.setTimeout(resolve, 50)); });
    // Compared as booleans, not as DOM nodes: matching a DOM node with
    // expect(...).toBeNull() never returns when the node is there.
    expect(document.querySelector('[data-slot="dropdown-menu-content"]') === null).toBe(true);
    expect(document.querySelector('input[data-slot="command-input"]') === null).toBe(true);
  });
});
