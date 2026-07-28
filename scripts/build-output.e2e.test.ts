import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('wires output cleanup and rollback into the build command', async () => {
  const scripts = JSON.parse(await readFile('package.json', 'utf8')).scripts;

  expect(scripts.build).toContain('scripts/build-with-rollback.mjs');
  expect(scripts['build:restore']).toContain('scripts/restore-build-output.mjs');
});
