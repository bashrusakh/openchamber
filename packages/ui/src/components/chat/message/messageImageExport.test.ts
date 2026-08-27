import { describe, expect, test } from 'bun:test';
import { Window } from 'happy-dom';

import { collectMessageTextExportSources } from './messageImageExport';

Object.assign(globalThis, { document: new Window().document });

const createRoot = (markup: string): Element => {
    const root = document.createElement('div');
    root.setAttribute('data-message-text-export-root', 'true');
    root.innerHTML = markup;
    return root;
};

describe('collectMessageTextExportSources', () => {
    test('collects one text source without changing its content', () => {
        const root = createRoot('<div data-message-text-export-source="true">Only answer</div>');

        const sources = collectMessageTextExportSources(root);

        expect(sources).toHaveLength(1);
        expect(sources[0]?.textContent).toBe('Only answer');
    });

    test('collects non-empty text sources in document order around unmarked tool content', () => {
        const root = createRoot(
            '<div data-message-text-export-source="true">Before tool</div>'
            + '<div data-tool-card="true">Tool output</div>'
            + '<div data-message-text-export-source="true">After tool</div>',
        );

        const sources = collectMessageTextExportSources(root);

        expect(sources.map((source) => source.textContent)).toEqual(['Before tool', 'After tool']);
    });

    test('does not include sources belonging to a nested export root', () => {
        const root = createRoot(
            '<div data-message-text-export-source="true">Answer before reasoning</div>'
            + '<div data-message-text-export-root="true">'
            + '<div data-message-text-export-source="true">Nested reasoning</div>'
            + '</div>'
            + '<div data-message-text-export-source="true">Answer after reasoning</div>',
        );

        const sources = collectMessageTextExportSources(root);

        expect(sources.map((source) => source.textContent)).toEqual([
            'Answer before reasoning',
            'Answer after reasoning',
        ]);
    });

    test('keeps a nested root usable for its own image action', () => {
        const root = createRoot(
            '<div data-message-text-export-root="true">'
            + '<div data-message-text-export-source="true">Nested reasoning</div>'
            + '</div>',
        );
        const nestedRoot = root.querySelector('[data-message-text-export-root]');

        expect(collectMessageTextExportSources(nestedRoot).map((source) => source.textContent)).toEqual(['Nested reasoning']);
    });

    test('ignores empty sources and a missing root', () => {
        const root = createRoot(
            '<div data-message-text-export-source="true">   </div>'
            + '<div data-message-text-export-source="true">Visible answer</div>',
        );

        expect(collectMessageTextExportSources(root).map((source) => source.textContent)).toEqual(['Visible answer']);
        expect(collectMessageTextExportSources(null)).toEqual([]);
    });
});
