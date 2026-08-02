import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { expect, it } from 'vitest';

async function productionTypeScriptFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await productionTypeScriptFiles(path)));
    } else if (
      entry.isFile() &&
      (path.endsWith('.ts') || path.endsWith('.tsx')) &&
      !path.endsWith('.test.ts') &&
      !path.endsWith('.test.tsx')
    ) {
      files.push(path);
    }
  }
  return files;
}

it('keeps production code off the retired model contract', async () => {
  const sourceRoot = join(process.cwd(), 'source');
  const files = (await productionTypeScriptFiles(sourceRoot)).filter(
    (file) => relative(sourceRoot, file) !== 'contracts/model.ts',
  );
  const violations: string[] = [];
  const legacyIdentifiers = /\b(?:ModelRequest|ModelResponse|StreamEvent|LegacyModel|LegacyModelProvider)\b/;
  const legacyContractImport = /contracts\/model\.js/;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    if (legacyIdentifiers.test(source) || legacyContractImport.test(source)) {
      violations.push(relative(process.cwd(), file));
    }
  }

  expect(violations).toEqual([]);
});
