import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';

const testRunnerScripts = [
  'test',
  'test:e2e',
  'test:codex-network',
  'test:provider-black-box',
  'provider:fixture:scan',
  'test:docker-host-control-integration',
  'test:verbose',
  'test:vitest:watch',
  'test:vitest:coverage',
] as const;

it('pins NODE_ENV=test cross-platform for every Vitest-facing package script', async () => {
  const { scripts } = JSON.parse(await readFile('package.json', 'utf8')) as { scripts: Record<string, string> };
  const directVitestScripts = Object.entries(scripts)
    .filter(([, command]) => command.includes('vitest'))
    .map(([name]) => name)
    .sort();

  expect(directVitestScripts).toEqual(testRunnerScripts.filter((name) => name !== 'test:provider-black-box').sort());

  for (const name of testRunnerScripts) {
    expect(scripts[name]).toMatch(/^cross-env NODE_ENV=test(?:\s|$)/);
    expect(scripts[name]).not.toMatch(/^(?:NODE_ENV|RUN_[A-Z_]+)=/);
  }
});
