import React, { act } from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { Window } from 'happy-dom';
import type { DeviceInfo } from '@/lib/device';
import type { ThemeContextValue } from '@/contexts/theme-system-context';
import { getThemeById } from '@/lib/theme/themes';

const MOBILE_DEVICE: DeviceInfo = {
  isMobile: true,
  isTablet: false,
  isDesktop: false,
  deviceType: 'mobile',
  screenWidth: 390,
  breakpoint: 'sm',
  hasTouchInput: true,
  hasTouchOnlyPointer: true,
};

const actualDevice = await import('@/lib/device');
mock.module('@/lib/device', () => ({
  ...actualDevice,
  useDeviceInfo: () => MOBILE_DEVICE,
}));

const { ThemePicker } = await import('./ThemePicker');
const { I18nProvider } = await import('@/lib/i18n');
const { ThemeSystemContext } = await import('@/contexts/theme-system-context');

const SEARCH_PLACEHOLDER = 'Search themes...';

const OPTIONS = [
  { id: 'built-in', label: 'Built in' },
  { id: 'imported', label: 'Imported' },
];

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

describe('ThemePicker behavior', () => {
  test('the mobile sheet focuses its search field and the delete action puts the caret back', async () => {
    const dom = installDom();
    const { createRoot } = await import('react-dom/client');
    const root = createRoot(dom.container);
    const deleted: string[] = [];

    function Harness() {
      const [options, setOptions] = React.useState(OPTIONS);
      const theme = getThemeById('openchamber-dark');
      if (!theme) throw new Error('Expected built-in theme');
      const context = React.useMemo<ThemeContextValue>(() => ({
        currentTheme: theme,
        availableThemes: [theme],
        customThemeIds: options.filter((option) => option.id === 'imported').map((option) => option.id),
        customThemesLoading: false,
        setTheme: () => undefined,
        reloadCustomThemes: async () => undefined,
        importTheme: async () => theme,
        deleteImportedTheme: async (themeId: string) => {
          deleted.push(themeId);
          setOptions((current) => current.filter((option) => option.id !== themeId));
        },
        isSystemPreference: false,
        setSystemPreference: () => undefined,
        themeMode: 'dark',
        setThemeMode: () => undefined,
        lightThemeId: 'openchamber-light',
        darkThemeId: 'openchamber-dark',
        setLightThemePreference: () => undefined,
        setDarkThemePreference: () => undefined,
      }), [options, theme]);
      return (
        <ThemeSystemContext.Provider value={context}>
          <ThemePicker
            options={options}
            value={options[0]?.id ?? ''}
            onValueChange={() => undefined}
            placeholder="Theme"
            ariaLabel="Theme"
          />
        </ThemeSystemContext.Provider>
      );
    }

    try {
      await act(async () => root.render(
        <I18nProvider>
          <Harness />
        </I18nProvider>,
      ));

      const trigger = dom.container.querySelector<HTMLButtonElement>('button');
      if (!trigger) throw new Error('Missing theme trigger');
      await act(async () => trigger.click());

      // The sheet focuses its search field, so typing filters the list right
      // away. Compared as text, not as DOM nodes: matching two DOM nodes with
      // expect(...).toBe(...) never returns when they differ.
      const search = document.querySelector<HTMLInputElement>(`input[placeholder="${SEARCH_PLACEHOLDER}"]`);
      if (!search) throw new Error('Missing theme search input');
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
      expect(document.activeElement === search).toBe(true);

      // Tapping a row's delete button takes the focus with it.
      const remove = document.querySelector<HTMLButtonElement>('button[aria-label="Delete imported theme Imported"]');
      if (!remove) throw new Error('Missing delete button');
      await act(async () => { remove.focus(); });
      expect(document.activeElement?.getAttribute('aria-label')).toBe('Delete imported theme Imported');
      await act(async () => { remove.click(); });
      expect(deleted).toEqual(['imported']);

      // The row is gone; the caret belongs back in the search field.
      expect(document.activeElement?.getAttribute('placeholder')).toBe(SEARCH_PLACEHOLDER);
      expect(document.activeElement === search).toBe(true);
    } finally {
      await act(async () => root.unmount());
      dom.restore();
    }
  });
});
