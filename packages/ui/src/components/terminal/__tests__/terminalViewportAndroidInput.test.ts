/**
 * Regression guard for Android terminal IME input.
 *
 * This remains source-scoped because packages/ui has no DOM environment for a
 * mount test (no jsdom / happy-dom), and ghostty-web only initializes in a
 * real mount. The beforeinput effect cannot be exercised behaviorally here.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const terminalViewportSource = readFileSync(join(__dirname, '..', 'TerminalViewport.tsx'), 'utf-8');

describe('Android terminal IME input', () => {
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
});
