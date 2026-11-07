import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSources(fullPath)));
    else if (entry.isFile() && /\.(ts|tsx)$/.test(fullPath) && !/\.(test|spec)\.(ts|tsx)$/.test(fullPath)) {
      files.push(fullPath);
    }
  }
  return files;
}

it('forbids retired SDK stream envelopes throughout production source', async () => {
  const violations: string[] = [];
  for (const file of await productionSources(path.resolve('src'))) {
    const source = await readFile(file, 'utf8');
    if (/raw_model_stream_event|run_item_stream_event|legacy-agent-stream-adapter/.test(source)) {
      violations.push(`${path.relative(path.resolve('src'), file)}: retired stream envelope`);
    }
    if (/data\?\.event|event\?\.event/.test(source)) {
      violations.push(`${path.relative(path.resolve('src'), file)}: nested SDK event envelope`);
    }
    if (
      /type\s*===?\s*['"]model['"]\s*&&[\s\S]{0,120}event/.test(source) ||
      /type\s*:\s*['"]model['"][\s,}][\s\S]{0,120}\bevent\s*:/.test(source)
    ) {
      violations.push(`${path.relative(path.resolve('src'), file)}: nested model/event envelope`);
    }
  }
  expect(violations).toEqual([]);
});
