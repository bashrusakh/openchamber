import React, { act } from 'react';
import { expect, test } from 'bun:test';
import { Window } from 'happy-dom';

const browser = new Window({ url: 'http://localhost/' });
Object.assign(globalThis, {
  window: browser, document: browser.document, navigator: browser.navigator, localStorage: browser.localStorage,
  Element: browser.Element, HTMLElement: browser.HTMLElement, Node: browser.Node,
  Event: browser.Event, CustomEvent: browser.CustomEvent, KeyboardEvent: browser.KeyboardEvent, MouseEvent: browser.MouseEvent,
  MutationObserver: browser.MutationObserver, ResizeObserver: browser.ResizeObserver,
  getComputedStyle: browser.getComputedStyle.bind(browser), requestAnimationFrame: browser.requestAnimationFrame.bind(browser),
  cancelAnimationFrame: browser.cancelAnimationFrame.bind(browser), IS_REACT_ACT_ENVIRONMENT: true,
});
// The picker's reads never answer here; the sheet renders its search field anyway.
globalThis.fetch = Object.assign(() => new Promise<Response>(() => {}), globalThis.fetch);

const actualUIStore = await import('@/stores/useUIStore');
actualUIStore.useUIStore.setState({ isMobile: true });

const { ReferencePickerDialog } = await import('./ReferencePickerDialog');
const { I18nProvider } = await import('@/lib/i18n');
const { RuntimeAPIContext } = await import('@/contexts/runtimeAPIContext');
const { createWebAPIs } = await import('../../../../web/src/api/index');

const SEARCH_LABEL = 'Search, or paste a link or #number';

test('the mobile reference sheet focuses its search field', async () => {
  const { createRoot } = await import('react-dom/client');
  const apis = createWebAPIs();
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(
      <I18nProvider>
        <RuntimeAPIContext.Provider value={apis}>
          <ReferencePickerDialog
            open
            onOpenChange={() => undefined}
            source="github"
            purpose="worktree"
            selection="single"
            directory="/repo"
            onConfirm={async () => null}
          />
        </RuntimeAPIContext.Provider>
      </I18nProvider>,
    ));

    // The sheet focuses its search field, so typing filters the list right
    // away. Compared as text, not as DOM nodes: matching two DOM nodes with
    // expect(...).toBe(...) never returns when they differ.
    const search = document.querySelector<HTMLInputElement>(`input[aria-label="${SEARCH_LABEL}"]`);
    expect(search).not.toBeNull();
    expect(document.activeElement?.getAttribute('aria-label')).toBe(SEARCH_LABEL);
    expect(document.activeElement === search).toBe(true);
  } finally {
    await act(async () => root.unmount());
  }
});
