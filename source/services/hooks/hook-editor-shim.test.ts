import { existsSync, readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, afterEach } from 'vitest';
import { ensureHookEditorShim, HOOK_DECLARATION_SHIM_FILENAME, HOOK_TSCONFIG_FILENAME } from './hook-editor-shim.js';

describe('hook-editor-shim', () => {
  const testRoot = join(tmpdir(), `term2-hook-shim-test-${Date.now()}`);

  afterEach(async () => {
    try {
      await rm(testRoot, { recursive: true, force: true });
    } catch {
      // Ignore cleanup error
    }
  });

  it('creates term2-hooks.d.ts and tsconfig.json in the target hook root', async () => {
    await ensureHookEditorShim(testRoot);

    const shimPath = join(testRoot, HOOK_DECLARATION_SHIM_FILENAME);
    const tsconfigPath = join(testRoot, HOOK_TSCONFIG_FILENAME);

    expect(existsSync(shimPath)).toBe(true);
    expect(existsSync(tsconfigPath)).toBe(true);

    const shimContent = readFileSync(shimPath, 'utf8');
    expect(shimContent).toContain("declare module '@qduc/term2/hooks'");
    expect(shimContent).toContain('Term2Hooks');

    const tsconfigContent = JSON.parse(readFileSync(tsconfigPath, 'utf8'));
    expect(tsconfigContent.compilerOptions.paths['@qduc/term2/hooks']).toEqual(['./term2-hooks.d.ts']);
  });
});
