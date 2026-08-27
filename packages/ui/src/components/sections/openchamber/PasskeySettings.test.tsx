import React from 'react';
import { describe, expect, test } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

import { SettingsFieldRow } from '@/components/sections/shared/SettingsSection';
import { PasskeyLabel } from './PasskeySettings';

describe('PasskeyLabel', () => {
  test('keeps long names constrained while preserving the full value', () => {
    const label = 'A passkey name that is long enough to exceed the fixed settings label column';
    const markup = renderToStaticMarkup(<PasskeyLabel label={label} />);

    expect(markup).toContain('class="block min-w-0 truncate"');
    expect(markup).toContain(`title="${label}"`);
    expect(markup).toContain(label);
  });

  test('keeps the direct field label flex item shrinkable', () => {
    const markup = renderToStaticMarkup(
      <SettingsFieldRow label={<PasskeyLabel label="Long passkey name" />}>
        <span>Details</span>
      </SettingsFieldRow>,
    );

    expect(markup).toContain('min-w-0"><span class="block min-w-0 truncate"');
  });
});
