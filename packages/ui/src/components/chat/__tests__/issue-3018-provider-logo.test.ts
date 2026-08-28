/**
 * Regression coverage for https://github.com/openchamber/openchamber/issues/3018.
 *
 * Mobile provider sections must show the same provider logo used by the
 * favorites and recent model rows.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const modelControlsSource = readFileSync(join(__dirname, '..', 'ModelControls.tsx'), 'utf-8');

describe('issue #3018 mobile provider model rows', () => {
    test('renders provider logos in provider sections', () => {
        const providerRowsStart = modelControlsSource.indexOf(
            '{providerModels.map((model: ProviderModel) => renderMobileModelRow({',
        );
        const providerRowsEnd = modelControlsSource.indexOf('                                        }))}', providerRowsStart);
        const providerRows = modelControlsSource.slice(providerRowsStart, providerRowsEnd);
        const mobileRowRendererStart = modelControlsSource.indexOf('const renderMobileModelRow = ({');
        const mobileRowRendererEnd = modelControlsSource.indexOf('const hasResults =', mobileRowRendererStart);
        const mobileRowRenderer = modelControlsSource.slice(mobileRowRendererStart, mobileRowRendererEnd);

        expect(providerRowsStart).toBeGreaterThanOrEqual(0);
        expect(providerRowsEnd).toBeGreaterThan(providerRowsStart);
        expect(providerRows).toContain('showProviderLogo: true');
        expect(providerRows).toContain('providerLogoAriaHidden: true');
        expect(mobileRowRenderer).toContain('<span aria-hidden="true"');
    });
});
