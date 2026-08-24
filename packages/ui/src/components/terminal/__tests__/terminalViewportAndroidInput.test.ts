/**
 * Regression guard for #3096.
 *
 * Ghostty disables text transformations on its hidden textarea, but focuses the
 * contenteditable terminal host. Android IMEs use that host for normal typing.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewportSource = readFileSync(join(__dirname, '..', 'TerminalViewport.tsx'), 'utf-8');

const terminalHostStart = terminalViewportSource.indexOf('return (\n    <div');
const terminalHostEnd = terminalViewportSource.indexOf('/>', terminalHostStart);
const terminalHost = terminalViewportSource.slice(terminalHostStart, terminalHostEnd);

const inputHandlerStart = terminalViewportSource.indexOf('const handleBeforeInput =');
const inputEffectStart = terminalViewportSource.lastIndexOf('React.useEffect(() => {', inputHandlerStart);
const inputEffectEnd = terminalViewportSource.indexOf('}, [enableTouchScroll, ready]);', inputHandlerStart);
const inputEffect = terminalViewportSource.slice(inputEffectStart, inputEffectEnd);

describe('issue #3096: Android terminal IME input', () => {
  test("disables text transformations on Ghostty's focused terminal host", () => {
    expect(terminalHost).toContain('autoCapitalize="off"');
    expect(terminalHost).toContain('autoCorrect="off"');
    expect(terminalHost).toContain('spellCheck={false}');
  });

  test('forwards untouched Android beforeinput text only through the touch input path', () => {
    expect(inputEffect).toContain('if (!enableTouchScroll || !container) return;');
    expect(inputEffect).toContain('if (input.data) inputRef.current(input.data);');
  });
});
