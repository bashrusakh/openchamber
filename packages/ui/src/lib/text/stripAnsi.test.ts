import { describe, expect, test } from 'bun:test';

import { stripAnsi } from './stripAnsi';

const ESC = '\x1B';
// eslint-disable-next-line no-control-regex
const ESC_PATTERN = /\x1B/;

describe('stripAnsi', () => {
    test('returns empty string for empty input', () => {
        expect(stripAnsi('')).toBe('');
    });

    test('returns plain text unchanged', () => {
        const text = 'just some plain text\nacross multiple lines\n';
        expect(stripAnsi(text)).toBe(text);
    });

    test('removes SGR color and style codes', () => {
        const input = `${ESC}[2m─── packages/ui/src/file.ts:1-2 ───${ESC}[0m`;
        expect(stripAnsi(input)).toBe('─── packages/ui/src/file.ts:1-2 ───');
    });

    test('removes 24-bit background and foreground colors', () => {
        const input = `${ESC}[48;2;38;38;38m         subtask: subtask || undefined,${ESC}[0m${ESC}[0m`;
        expect(stripAnsi(input)).toBe('         subtask: subtask || undefined,');
    });

    test('removes cursor movement and erase sequences', () => {
        const input = `before${ESC}[2J${ESC}[H${ESC}[1;1Hafter`;
        expect(stripAnsi(input)).toBe('beforeafter');
    });

    test('removes OSC sequences terminated by BEL', () => {
        // ESC ] 0 ; title BEL — sets the window title and ends at BEL (\x07).
        // A separate CSI sequence after it is also stripped by the CSI pass.
        const input = `text${ESC}]0;window title\x07${ESC}[2mafter${ESC}[0m`;
        expect(stripAnsi(input)).toBe('textafter');
    });

    test('removes OSC sequences terminated by ST', () => {
        const input = `text${ESC}]0;window title${ESC}\\after`;
        expect(stripAnsi(input)).toBe('textafter');
    });

    test('removes DCS payload (e.g. sixel)', () => {
        const input = `before${ESC}Pq#0;2;0;0;0#1;2;100;100;0${ESC}\\after`;
        expect(stripAnsi(input)).toBe('beforeafter');
    });

    test('removes two-byte ESC sequences (charset selection)', () => {
        // ESC % G selects UTF-8 in some terminals.
        const input = `before${ESC}%Gafter`;
        expect(stripAnsi(input)).toBe('beforeafter');
    });

    test('preserves the multi-line summary format from the OCR review CLI', () => {
        const input = [
            `${ESC}[2m─── packages/ui/src/components/sections/commands/CommandsPage.tsx:164-164 ───${ESC}[0m`,
            'Using `subtask || undefined` converts `false` to `undefined`, which means the saved config will only',
            `include \`subtask\` when it's \`true\`. This is intentional for omitting falsy values, but it differs`,
            '',
            `${ESC}[2m${ESC}[48;2;38;38;38m ${ESC}[0m${ESC}[48;2;38;38;38m         subtask: subtask || undefined,${ESC}[0m${ESC}[0m`,
        ].join('\n');

        const cleaned = stripAnsi(input);

        // No CSI / OSC / DCS residue visible to the user.
        expect(ESC_PATTERN.test(cleaned)).toBe(false);
        expect(cleaned.includes('[2m')).toBe(false);
        expect(cleaned.includes('[0m')).toBe(false);
        expect(cleaned.includes('[48;2;38;38;38m')).toBe(false);

        // Visible text is preserved verbatim.
        expect(cleaned).toContain('─── packages/ui/src/components/sections/commands/CommandsPage.tsx:164-164 ───');
        expect(cleaned).toContain("Using `subtask || undefined` converts `false` to `undefined`");
        expect(cleaned).toContain('         subtask: subtask || undefined,');
    });

    test('is idempotent', () => {
        const input = `${ESC}[31mred${ESC}[0m plain ${ESC}[2J${ESC}[Hdone`;
        const once = stripAnsi(input);
        const twice = stripAnsi(once);
        expect(twice).toBe(once);
    });

    test('leaves a single ESC byte alone when there is nothing to consume', () => {
        // A bare ESC that does not start a known sequence is stripped defensively
        // so it cannot leak as a control character into rendered text.
        expect(stripAnsi(`text${ESC}more`)).toBe('textmore');
    });
});