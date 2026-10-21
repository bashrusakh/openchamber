import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

/**
 * The desktop half of the branch picker.
 *
 * It lives in its own file because the DOM renderer is imported here, after
 * the test globals are in place: React's renderer captures the document it
 * first sees, and Base UI's menu only opens a popup against that document.
 * The renderer-probe bootstrap the sibling mobile test uses leaves the menu
 * closed under happy-dom, so the desktop surface needs this one.
 */
test('the desktop dropdown asks for the focus itself, not the popup focus manager', async () => {
  const dom = new Window({ url: 'http://localhost' });
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const globals = {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
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
  const { createRoot } = await import('react-dom/client');
  const { NewWorktreeBranchPicker } = await import('./NewWorktreeBranchPicker');
  const { I18nProvider } = await import('@/lib/i18n');
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  // Base UI's popup focus manager focuses the first tabbable element from a
  // passive effect, after the commit that opened the popup. A field that is
  // already focused when the popup lands was focused by the component's own
  // request, in that commit.
  let focusedWhenPopupLanded: string | null | undefined = 'never-observed';
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
          isMobile={false}
          onSelect={() => undefined}
        />
      </I18nProvider>,
    ));
    const trigger = container.querySelector<HTMLButtonElement>('button');
    if (!trigger) throw new Error('Missing branch trigger');

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
    // Compared as text, not as DOM nodes: matching two DOM nodes with
    // expect(...).toBe(...) never returns when they differ.
    expect(document.activeElement?.getAttribute('data-slot')).toBe('command-input');
    expect(document.activeElement === search).toBe(true);
  } finally {
    await act(async () => root.unmount());
    await dom.happyDOM.abort();
    for (const [name, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, name, descriptor);
      else Reflect.deleteProperty(globalThis, name);
    }
  }
});
