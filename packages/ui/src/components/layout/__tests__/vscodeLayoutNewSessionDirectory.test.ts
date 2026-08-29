import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const layoutSource = readFileSync(join(__dirname, '..', 'VSCodeLayout.tsx'), 'utf8');

describe('VS Code editor new-session directory bootstrap', () => {
  test('passes the bootstrap workspace folder to the automatic draft initializer', () => {
    expect(layoutSource).toContain("import { getVSCodeBootstrapConfig } from '@/stores/utils/vscodeRuntime';");
    expect(layoutSource).toContain('const bootstrapWorkspaceFolder = React.useMemo<string | null>(() => {');
    expect(layoutSource).toContain('const configured = getVSCodeBootstrapConfig()?.workspaceFolder;');
    expect(layoutSource).toContain('openNewSessionDraft({ automatic: true, directoryOverride: bootstrapWorkspaceFolder });');
  });

  test('keeps the bootstrap override in the editor-only automatic path', () => {
    const effectStart = layoutSource.indexOf("if (viewMode !== 'editor') {");
    const effectEnd = layoutSource.indexOf('\n  // Track container width', effectStart);
    expect(effectStart).toBeGreaterThan(-1);
    expect(effectEnd).toBeGreaterThan(effectStart);

    const effect = layoutSource.slice(effectStart, effectEnd);
    expect(effect).toContain('directoryOverride: bootstrapWorkspaceFolder');
    expect(effect).toContain('if (!initialSessionId) {');
  });
});
