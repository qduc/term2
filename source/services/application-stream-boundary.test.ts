import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { expect, it } from 'vitest';

const canonicalConsumers = [
  'source/services/stream-event-processor.ts',
  'source/services/session/session-stream-processor.ts',
  'source/services/agent-stream.ts',
];

async function productionSources(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await productionSources(fullPath)));
    else if (entry.isFile() && fullPath.endsWith('.ts') && !fullPath.endsWith('.test.ts')) files.push(fullPath);
  }
  return files;
}

it('proves the application run loop constructs a native stream for processStreamEvents', async () => {
  const source = await readFile('source/services/agent-runtime/application-run-loop.ts', 'utf8');
  expect(source).toContain('createAgentStream');
  expect(source).not.toContain('adaptAgentStream');
});

it('keeps runtime streams on the native application event protocol', async () => {
  const sources = await Promise.all(canonicalConsumers.map((file) => readFile(file, 'utf8')));
  for (const source of sources) {
    expect(source).not.toMatch(/raw_model_stream_event|run_item_stream_event/);
    expect(source).not.toMatch(/data\??\.event|event\??\.event/);
  }
});

it('forbids retired SDK stream envelopes throughout production source', async () => {
  const violations: string[] = [];
  for (const file of await productionSources(path.resolve('source'))) {
    const source = await readFile(file, 'utf8');
    if (/raw_model_stream_event|run_item_stream_event|legacy-agent-stream-adapter/.test(source)) {
      violations.push(`${path.relative(path.resolve('source'), file)}: retired stream envelope`);
    }
    if (/data\?\.event|event\?\.event/.test(source)) {
      violations.push(`${path.relative(path.resolve('source'), file)}: nested SDK event envelope`);
    }
    if (
      /type\s*===?\s*['"]model['"]\s*&&[\s\S]{0,120}event/.test(source) ||
      /type\s*:\s*['"]model['"][\s,}][\s\S]{0,120}\bevent\s*:/.test(source)
    ) {
      violations.push(`${path.relative(path.resolve('source'), file)}: nested model/event envelope`);
    }
  }
  expect(violations).toEqual([]);
});
