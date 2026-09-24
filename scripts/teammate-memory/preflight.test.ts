import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, it } from 'vitest';
import { isSnapshotAvailable, prepareR1 } from './preflight.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
  roots.length = 0;
});

it.skipIf(!isSnapshotAvailable())(
  'prepares isolated history-free R1 workspaces and proves the A/B retrieval contrast',
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'teammate-r1-'));
    roots.push(root);
    const output = join(root, 'pilot');
    const manifest = await prepareR1(output);
    expect(manifest.valid).toBe(true);
    expect(manifest.snapshot).toBe('a1142650');
    expect(manifest.model).toBe('codex/gpt-6-luna');
    expect(manifest.aContext).not.toContain('distinct physical WebSocket');
    expect(manifest.bContext).toContain('distinct physical WebSocket');
    expect(manifest.bContext).not.toContain('Do not disable chaining.');
    const a = join(output, 'A');
    const b = join(output, 'B');
    for (const arm of [a, b]) {
      expect(existsSync(join(arm, 'workspace', 'source', 'agent.ts'))).toBe(true);
      expect(existsSync(join(arm, 'workspace', '.git'))).toBe(false);
      expect(existsSync(join(arm, 'workspace', 'eval', 'teammate-memory', 'README.md'))).toBe(false);
    }
    expect(readFileSync(join(a, 'memory', 'projects', manifest.projectIds.A, 'index.json'), 'utf8')).toBe(
      readFileSync(join(b, 'memory', 'projects', manifest.projectIds.B, 'index.json'), 'utf8'),
    );
    expect(() => prepareR1(output)).rejects.toThrow();
  },
);
