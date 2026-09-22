import { describe, expect, test } from 'bun:test';
import type { TextPart } from '@opencode-ai/sdk/v2';

import { CONSULT_RECEIPT_CARRIER_TEXT, CONSULT_RECEIPT_METADATA_KEY } from '@/lib/consult/synthesis';
import { createContextPart } from '@/lib/messages/contextParts';
import { filterVisibleParts } from './partUtils';

/**
 * The consult receipt carrier is a transport-only synthetic text part the
 * send paths insert when the acting message has no text part of its own. The
 * visibility filter must never render it, with or without sibling parts.
 */

const textPart = (
    fields: Pick<TextPart, 'text'> & Partial<Pick<TextPart, 'synthetic' | 'metadata'>>,
): TextPart => ({
    id: 'prt_1',
    sessionID: 'ses_1',
    messageID: 'msg_1',
    type: 'text',
    ...fields,
});

const receiptMetadata: TextPart['metadata'] = {
    [CONSULT_RECEIPT_METADATA_KEY]: { runID: 'run-1' },
};

const carrierPart = (): TextPart => textPart({
    text: CONSULT_RECEIPT_CARRIER_TEXT,
    synthetic: true,
    metadata: receiptMetadata,
});

const contextPart = (): TextPart => textPart({
    ...createContextPart({
        kind: 'terminal',
        terminalId: 'term-1',
        terminalLabel: 'Terminal',
        startLine: 1,
        endLine: 2,
        output: 'bun test',
    }),
});

describe('filterVisibleParts', () => {
    test('drops a lone consult receipt carrier so it renders nothing', () => {
        expect(filterVisibleParts([carrierPart()])).toEqual([]);
    });

    test('drops the carrier beside the context-only message it belongs to', () => {
        const context = contextPart();
        expect(filterVisibleParts([context, carrierPart()])).toEqual([context]);
    });

    test('drops the carrier instead of double-showing it beside user text', () => {
        const userText = textPart({ text: 'the consult' });
        expect(filterVisibleParts([carrierPart(), userText])).toEqual([userText]);
    });

    test('keeps a synthetic context part visible on its own', () => {
        const context = contextPart();
        expect(filterVisibleParts([context])).toEqual([context]);
    });

    test('keeps a synthetic context part visible beside user text', () => {
        const context = contextPart();
        const userText = textPart({ text: 'the consult' });
        expect(filterVisibleParts([context, userText])).toEqual([context, userText]);
    });

    test('keeps a synthetic text part that only looks like the carrier', () => {
        const lookalike = textPart({ text: CONSULT_RECEIPT_CARRIER_TEXT, synthetic: true });
        expect(filterVisibleParts([lookalike])).toEqual([lookalike]);
    });

    test('keeps user text that literally reads like the carrier', () => {
        const typed = textPart({ text: CONSULT_RECEIPT_CARRIER_TEXT, metadata: receiptMetadata });
        expect(filterVisibleParts([typed])).toEqual([typed]);
    });
});
