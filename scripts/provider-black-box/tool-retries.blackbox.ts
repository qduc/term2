import { expect, it } from 'vitest';
import { runScriptedToolCalls } from './tool-retry-fixture.js';

/**
 * Harness-caused tool retries found by auditing real benchmark runs: each scenario scripts the
 * model's bad call and asserts the result text the model is shown and the effect on disk.
 */

it('search_replace accepts the flat single-replacement shape the schema does not advertise', async () => {
  const run = await runScriptedToolCalls({
    files: { 'target.txt': 'alpha\nbeta\n' },
    readBack: ['target.txt'],
    calls: [
      ['search_replace', { path: 'target.txt', search_content: 'beta', replace_content: 'gamma' }],
      ['search_replace', { path: 'target.txt', search_content: 'alpha', replace_content: 'one', replacements: [] }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.toolResults[0]).toMatch(/^Updated target\.txt/);
  expect(run.files['target.txt']).toBe('alpha\ngamma\n');
  expect(run.toolResults[1]).toContain('not both');
  // The presented schema keeps the array form only.
  const tool = (run.requests[0]!.tools as Array<{ function: { name: string; parameters: any } }>).find(
    (t) => t.function.name === 'search_replace',
  )!;
  expect(Object.keys(tool.function.parameters.properties).sort()).toEqual(['path', 'replacements']);
});
