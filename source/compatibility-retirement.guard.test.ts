import { expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const productionRoot = path.resolve(import.meta.dirname);
const forbidden = [
  ['create', 'Runner'].join(''),
  ['Runner', 'Manager'].join(''),
  ['AgentRun', 'Orchestrator'].join(''),
  ['ApplicationCompatibility', 'Runner'].join(''),
  ['settleProvider', 'Run'].join(''),
  ['Legacy', 'Runner'].join(''),
];

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSources(fullPath)));
    else if (
      entry.isFile() &&
      (fullPath.endsWith('.ts') || fullPath.endsWith('.tsx')) &&
      !fullPath.endsWith('.test.ts') &&
      !fullPath.endsWith('.test.tsx')
    )
      files.push(fullPath);
  }
  return files;
}

it('keeps retired runner infrastructure out of production source', async () => {
  const violations: string[] = [];
  for (const file of await productionSources(productionRoot)) {
    const text = await readFile(file, 'utf8');
    for (const name of forbidden) {
      if (text.includes(name)) violations.push(`${path.relative(productionRoot, file)}: ${name}`);
    }
  }
  expect(violations).toEqual([]);
});
