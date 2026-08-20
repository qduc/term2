import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Guards against re-introducing an app-level DEC Mode 2026 synchronized-output
 * patch on process.stdout.
 *
 * Ink 7.0.1 already brackets every interactive render frame with
 * `\x1b[?2026h … \x1b[?2026l` (see node_modules/ink/build/write-synchronized.js).
 * Wrapping individual stdout.write() calls a second time breaks that
 * frame-level atomicity and makes the terminal paint blank/partial
 * intermediate frames — visible flicker while streaming.
 *
 * The actual ESC bytes (not the literal `\x1b` spelling, which appears in
 * comments) are what a terminal would act on, so this guard matches those.
 */

const productionRoot = path.resolve(import.meta.dirname);
const SYNC_BEGIN = '\u001b[?2026h';
const SYNC_END = '\u001b[?2026l';

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionSources(fullPath)));
    } else if (
      entry.isFile() &&
      (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) &&
      !fullPath.endsWith('.test.ts') &&
      !fullPath.endsWith('.test.tsx')
    ) {
      files.push(fullPath);
    }
  }
  return files;
}

it('keeps manual DEC Mode 2026 stdout wrapping out of production source', async () => {
  const violations: string[] = [];
  for (const file of await productionSources(productionRoot)) {
    const text = await readFile(file, 'utf8');
    if (text.includes(SYNC_BEGIN)) {
      violations.push(`${path.relative(productionRoot, file)}: emitted ${JSON.stringify(SYNC_BEGIN)}`);
    }
    if (text.includes(SYNC_END)) {
      violations.push(`${path.relative(productionRoot, file)}: emitted ${JSON.stringify(SYNC_END)}`);
    }
  }
  expect(violations).toEqual([]);
});
