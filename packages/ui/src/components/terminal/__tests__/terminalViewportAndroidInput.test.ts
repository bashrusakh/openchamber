/**
 * Regression guard for #3096 (Android terminal IME input) and the PR #3111
 * fixes (attribute flags on the container, replay without early return).
 *
 * The container attributes (`autoCapitalize`, `autoCorrect`, `spellCheck`)
 * are verified through a REAL render of the component with
 * `renderToStaticMarkup`: the assertions run against the actual HTML output
 * of `<TerminalViewport />`, not against the source file, so they catch a
 * regression even if the attributes are moved, renamed, or applied through
 * a different mechanism.
 *
 * The beforeinput handler and the chunk-replay logic are still pinned by
 * source fragments (scoped to the relevant block, not the whole file):
 * `packages/ui` has no DOM environment for a mount test (no jsdom /
 * happy-dom), and ghostty-web is a WASM bundle that only initializes in a
 * real mount — effects never run under `renderToStaticMarkup`, so event
 * wiring cannot be exercised behaviorally here.
 */
import React from 'react';
import { describe, expect, mock, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { TerminalTheme } from '@/lib/terminalTheme';

// ghostty-web is only imported lazily by the mount effect (which never runs
// under renderToStaticMarkup), but keep a stub so importing TerminalViewport
// can never pull in the WASM emulator bundle.
mock.module('ghostty-web', () => {
  class Terminal {
    cols = 80;
    rows = 24;
    options: Record<string, unknown> = {};
    loadAddon() {}
    open() {}
    write() {}
    reset() {}
    dispose() {}
    focus() {}
    scrollLines() {}
    getSelection() {
      return '';
    }
    getSelectionPosition() {
      return null;
    }
    onData() {
      return { dispose: () => {} };
    }
  }
  class FitAddon {
    fit() {}
  }
  return {
    Terminal,
    FitAddon,
    Ghostty: { load: async () => ({}) },
  };
});

const { TerminalViewport } = await import('../TerminalViewport');

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewportSource = readFileSync(join(__dirname, '..', 'TerminalViewport.tsx'), 'utf-8');

const theme: TerminalTheme = {
  background: '#000000',
  foreground: '#ffffff',
  cursor: '#ffffff',
  cursorAccent: '#000000',
  selectionBackground: '#ffffff',
  black: '#000000',
  red: '#ff0000',
  green: '#00ff00',
  yellow: '#ffff00',
  blue: '#0000ff',
  magenta: '#ff00ff',
  cyan: '#00ffff',
  white: '#ffffff',
  brightBlack: '#555555',
  brightRed: '#ff5555',
  brightGreen: '#55ff55',
  brightYellow: '#ffff55',
  brightBlue: '#5555ff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ffff',
  brightWhite: '#ffffff',
};

const renderTerminalViewport = () =>
  renderToStaticMarkup(
    React.createElement(TerminalViewport, {
      sessionKey: 'test-session',
      chunks: [],
      onInput: () => {},
      onResize: () => {},
      theme,
      fontFamily: 'monospace',
      fontSize: 14,
    }),
  );

describe('issue #3096: Android terminal IME input', () => {
  test('renders the container div with text-transformation flags disabled', () => {
    const markup = renderTerminalViewport();

    // The flags must be on the terminal host div, identified by
    // data-terminal-owner. Slice out that tag from the rendered HTML.
    const ownerIndex = markup.indexOf('data-terminal-owner="main"');
    expect(ownerIndex).toBeGreaterThan(-1);
    const tagStart = markup.lastIndexOf('<', ownerIndex);
    const tagEnd = markup.indexOf('>', ownerIndex);
    const containerTag = markup.slice(tagStart, tagEnd);

    expect(containerTag).toContain('autoCapitalize="off"');
    expect(containerTag).toContain('autoCorrect="off"');
    // renderToStaticMarkup keeps the camelCase attribute name and renders the
    // false value as a quoted attribute.
    expect(containerTag).toContain('spellCheck="false"');
  });

  test('forwards untouched Android beforeinput text only through the touch input path', () => {
    const handlerStart = terminalViewportSource.indexOf('const handleBeforeInput =');
    expect(handlerStart).toBeGreaterThan(-1);
    const wiringEnd = terminalViewportSource.indexOf(
      "container.addEventListener('beforeinput', handleBeforeInput);",
      handlerStart,
    );
    expect(wiringEnd).toBeGreaterThan(handlerStart);
    const inputHandler = terminalViewportSource.slice(handlerStart, wiringEnd);

    expect(inputHandler).toContain('if (input.isComposing) return;');
    expect(inputHandler).toContain('if (input.data) inputRef.current(input.data);');
  });

  test('replays a replacement chunk through the existing VT without returning early', () => {
    const start = terminalViewportSource.indexOf('if (previousIndex < 0) {');
    expect(start).toBeGreaterThan(-1);
    const end = terminalViewportSource.indexOf('flush();', start);
    expect(end).toBeGreaterThan(start);
    const discontinuity = terminalViewportSource.slice(start, end);

    expect(discontinuity).toContain('recreateRenderer();');
    // The regression: the replay used to stop after the reset, dropping the
    // pending chunks. The flush must still run.
    expect(discontinuity.indexOf('return;', discontinuity.indexOf('recreateRenderer();'))).toBe(-1);
    expect(discontinuity).toContain('const isReplay = previousIndex < 0;');
    expect(discontinuity).toContain('chunk.replayData ?? chunk.data');
  });
});
