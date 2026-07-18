import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

it('wires output cleanup into the build command', async () => {
  const packageJson = await readFile('package.json', 'utf8');

  expect(JSON.parse(packageJson).scripts.build).toContain('scripts/clean-build-output.mjs');
});
