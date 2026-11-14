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

it('search_replace skips a no-op pair in a batch, names the failing replacement, and keeps a lone no-op an error', async () => {
  const run = await runScriptedToolCalls({
    files: { 'a.txt': 'one\ntwo\nthree\n', 'b.txt': 'x\ny\n' },
    readBack: ['a.txt', 'b.txt'],
    calls: [
      [
        'search_replace',
        {
          path: 'a.txt',
          replacements: [
            { search_content: 'one', replace_content: 'one' },
            { search_content: 'two', replace_content: '2' },
            { search_content: 'three', replace_content: '3' },
          ],
        },
      ],
      [
        'search_replace',
        {
          path: 'b.txt',
          replacements: [
            { search_content: 'x', replace_content: 'X' },
            { search_content: 'absent', replace_content: 'Z' },
          ],
        },
      ],
      ['search_replace', { path: 'b.txt', replacements: [{ search_content: 'y', replace_content: 'y' }] }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  // (a) the no-op pair is skipped and reported; the rest is applied.
  expect(run.toolResults[0]).toContain('replacement 1 skipped: search and replace are identical');
  expect(run.toolResults[0]).not.toContain('Batch aborted');
  expect(run.files['a.txt']).toBe('one\n2\n3\n');
  // A real failure still aborts the batch atomically, and names which replacement failed and why.
  expect(run.toolResults[1]).toContain('replacement 2 of 2: Search content not found');
  expect(run.toolResults[1]).toContain('replacement 1 not applied: replacement 2 failed');
  expect(run.files['b.txt']).toBe('x\ny\n');
  // A single no-op call is the model's own mistake: still an error, with a clear reason.
  expect(run.toolResults[2]).toContain(
    'search_content and replace_content are identical, so there is nothing to change',
  );
});

const NEAR_MISS_FILE = [
  'import os',
  '',
  'def compute_totals(items, tax_rate):',
  '    subtotal = sum(item.price for item in items)',
  '    return subtotal * (1 + tax_rate)',
  '',
  'def unrelated():',
  '    return 42',
  '',
].join('\n');

it('apply_patch names the closest file line for a context line it cannot find, and nothing when none is close', async () => {
  const patch = (context: string) =>
    [
      '*** Begin Patch',
      '*** Update File: calc.py',
      '@@',
      context,
      '-    return 42',
      '+    return 43',
      '*** End Patch',
    ].join('\n');
  const run = await runScriptedToolCalls({
    model: 'openai/gpt-5',
    files: { 'calc.py': NEAR_MISS_FILE },
    readBack: ['calc.py'],
    calls: [
      ['apply_patch', { patch: patch(' def compute_total(items, tax_rate):') }],
      ['apply_patch', { patch: patch(' zebra_quantum_flux_capacitor = engage()') }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.toolResults[0]).toContain(
    'could not be found anywhere in the file; closest is line 3: "def compute_totals(items, tax_rate):"',
  );
  expect(run.toolResults[1]).toContain('could not be found anywhere in the file; no similar line found in the file');
  expect(run.toolResults[1]).not.toContain('closest is line');
  expect(run.files['calc.py']).toBe(NEAR_MISS_FILE);
});

it('search_replace names the closest file line when the search text is not found', async () => {
  const run = await runScriptedToolCalls({
    files: { 'calc.py': NEAR_MISS_FILE },
    readBack: ['calc.py'],
    calls: [
      [
        'search_replace',
        {
          path: 'calc.py',
          replacements: [
            {
              search_content: 'def compute_totals(items, tax_rate):\n    subtotal = sum(i.price for i in items)',
              replace_content: 'x',
            },
          ],
        },
      ],
      [
        'search_replace',
        { path: 'calc.py', replacements: [{ search_content: 'zebra_quantum_flux = engage()', replace_content: 'x' }] },
      ],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.toolResults[0]).toContain('Search content not found.');
  expect(run.toolResults[0]).toContain(
    'For search line 2 ("subtotal = sum(i.price for i in items)"), closest is line 4: "subtotal = sum(item.price for item in items)".',
  );
  expect(run.toolResults[1]).toContain('no similar line found in the file');
  expect(run.files['calc.py']).toBe(NEAR_MISS_FILE);
});

it('run_subagent names what is missing and shows both valid shapes', async () => {
  const run = await runScriptedToolCalls({
    calls: [
      ['run_subagent', { execution: 'foreground', name: 'scout', check_in: { enabled: true } }],
      ['run_subagent', { execution: 'foreground', role: 'explorer' }],
      ['run_subagent', { execution: 'foreground', role: 'worker', task: 'look', agent_spec: { goal: 'look' } }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  const shapes = 'needs either role+task (e.g. {"role":"explorer","task":"…"}) or agent_spec:{goal:"…"}';
  expect(run.toolResults[0]).toContain(`input missing role and task: ${shapes}`);
  expect(run.toolResults[0]).toContain('Received keys: check_in, execution, name.');
  expect(run.toolResults[1]).toContain(`role sent without task: ${shapes}`);
  // A writing role is still not rewritten: the mixed-shape tolerance stays limited to read-only roles.
  expect(run.toolResults[2]).toContain('Send role+task without agent_spec, or agent_spec alone');
  // The double full stop of the old message is gone.
  for (const text of run.toolResults) expect(text).not.toContain('..');
});
