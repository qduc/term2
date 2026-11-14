import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { captureApprovalPrompts, runScriptedToolCalls } from './tool-retry-fixture.js';

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

it('a schema mismatch says which tool the arguments belong to', async () => {
  const run = await runScriptedToolCalls({
    files: { 'a.txt': 'x\n' },
    calls: [
      ['shell', { path: 'a.txt', start_line: 1, end_line: 5 }],
      ['read_file', { command: 'ls' }],
      ['shell', { cmd: 'ls' }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(run.toolResults[0]).toContain('These arguments belong to read_file, not shell; shell needs command.');
  expect(run.toolResults[1]).toContain('These arguments belong to shell, not read_file; read_file needs path.');
  // An argument no other tool takes gets the plain diagnostic, with no misleading hint.
  expect(run.toolResults[2]).toContain('Tool input did not match schema for shell');
  expect(run.toolResults[2]).not.toContain('belong to');
});

it('the wrong-tool hint names only tools the calling agent is offered', async () => {
  const run = await runScriptedToolCalls({
    calls: [
      ['shell', { execution: 'foreground', role: 'explorer', task: 'look around' }],
      ['read_file', { search_content: 'a', replace_content: 'b' }],
      ['run_subagent', { execution: 'foreground', role: 'explorer', task: 'look around' }],
      ['shell', { execution: 'foreground', role: 'explorer', task: 'look again' }],
    ],
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  const hints = run.allToolResults.filter((text) => text.includes('Tool input did not match schema for shell'));
  // The root offers run_subagent and is told so; the explorer child it launched cannot call it and is not.
  expect(hints.filter((text) => text.includes('belong to run_subagent'))).toHaveLength(1);
  expect(hints.filter((text) => !text.includes('belong to'))).toHaveLength(1);
  // search_replace's flat keys count as its own for the hint.
  expect(run.allToolResults.join('\n')).toContain(
    'These arguments belong to search_replace, not read_file; read_file needs path.',
  );
});

/** The spooled file named by a result's "Full output saved to" note, as lines (no trailing empty line). */
const spoolOf = async (results: string[]): Promise<string[] | undefined> => {
  const path = /Full output saved to `([^`]+)`/.exec(results[0]!)?.[1];
  if (!path) return undefined;
  const lines = (await readFile(path, 'utf8')).split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
};

/**
 * A trim marker may state a line range only if it is in the spooled file's own numbering: the lines on
 * either side of the marker are then exactly the file lines around that range, and the note's total
 * is the file's length. Count-only markers make no range claim, and the total must still be right.
 */
const expectHonestTrim = (text: string, file: string[]) => {
  expect(text).toContain(`(${file.length} lines)`);
  const shown = text.split('\n');
  const markerAt = shown.findIndex((line) => /^\.\.\. \[.*trimmed.*\] \.\.\.$/.test(line));
  expect(markerAt, text.slice(0, 600)).toBeGreaterThan(-1);
  const range = /lines (\d+)-(\d+) of (\d+) trimmed/.exec(shown[markerAt]!);
  if (!range) return { ranged: false as const };
  const [from, to, total] = [Number(range[1]), Number(range[2]), Number(range[3])];
  expect(total).toBe(file.length);
  expect(file[from - 2]).toBe(shown[markerAt - 1]);
  expect(file[to]).toBe(shown[markerAt + 1]);
  // Everything the marker hides is in the file, and none of it is still in the result.
  const hidden = file.slice(from - 1, to);
  expect(hidden.length).toBe(to - from + 1);
  expect(shown.filter((line) => hidden.includes(line))).toEqual([]);
  return { ranged: true as const };
};

it('a trimmed shell result states the trimmed line range and the spooled file total, matching the file', async () => {
  const run = await runScriptedToolCalls({ calls: [['shell', { command: 'seq 1 1090' }]], inspect: spoolOf });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  expect(expectHonestTrim(run.toolResults[0]!, run.inspected as string[]).ranged).toBe(true);
});

it('trim markers make no wrong range claim when long lines or two streams add trim layers', async () => {
  const pad = 'x'.repeat(70);
  const long = await runScriptedToolCalls({
    calls: [['shell', { command: `seq 1 3000 | sed 's/$/ ${pad}/'` }]],
    inspect: spoolOf,
  });
  expect(long.exitCode, long.stderr + long.stdout).toBe(0);
  expectHonestTrim(long.toolResults[0]!, long.inspected as string[]);
  // Both streams over the line limit: the result is trimmed again as a whole after each stream's own trim.
  const both = await runScriptedToolCalls({
    calls: [['shell', { command: 'seq 1 1200; seq 5001 6200 >&2' }]],
    inspect: spoolOf,
  });
  expect(both.exitCode, both.stderr + both.stdout).toBe(0);
  expect(expectHonestTrim(both.toolResults[0]!, both.inspected as string[]).ranged).toBe(false);
});

it('a bounded read_file result states the spooled file total and makes no wrong range claim', async () => {
  const text = Array.from({ length: 3000 }, (_, i) => `line ${i + 1} ${'y'.repeat(40)}`).join('\n') + '\n';
  const run = await runScriptedToolCalls({
    files: { 'big.txt': text },
    calls: [['read_file', { path: 'big.txt' }]],
    inspect: spoolOf,
  });
  expect(run.exitCode, run.stderr + run.stdout).toBe(0);
  const file = run.inspected as string[];
  expect(file).toBeDefined();
  expect(run.toolResults[0]).toContain(`(${file.length} lines)`);
  // The text the result lacks is in the file: its first line is the file's first line.
  expect(file.join('\n')).toContain('line 3000 ');
  expect(run.toolResults[0]).not.toContain('line 3000 ');
  expect(run.toolResults[0]).not.toMatch(/lines \d+-\d+ of \d+ trimmed/);
});

it.skipIf(process.platform !== 'linux')(
  'regression guard: the approval prompt shows the flat search_replace form like the array form',
  async () => {
    // Guards existing behaviour, not a fix: arguments are normalised before they reach the
    // prompt on every shipped path (root and nested run_code), so this passes without any
    // prompt-side handling. It fails if that normalisation is ever lost.
    // The targets are outside the project, so each call needs the user's approval.
    const edit = (old: string, next: string) => ({ search_content: old, replace_content: next });
    const {
      screens: [flat, array, nested],
    } = await captureApprovalPrompts({
      files: { 'outside/a.txt': 'flat_old\n', 'outside/b.txt': 'array_old\n', 'outside/c.txt': 'nested_old\n' },
      calls: [
        ['search_replace', { path: '../outside/a.txt', ...edit('flat_old', 'flat_new') }],
        ['search_replace', { path: '../outside/b.txt', replacements: [edit('array_old', 'array_new')] }],
        [
          'run_code',
          {
            description: 'Edit through the script surface',
            code: "return await tools.search_replace({ path: '../outside/c.txt', search_content: 'nested_old', replace_content: 'nested_new' });",
          },
        ],
      ],
      awaitText: ['flat_new', 'array_new', 'nested_new'],
    });
    for (const [screen, old, next] of [
      [flat, 'flat_old', 'flat_new'],
      [array, 'array_old', 'array_new'],
      [nested, 'nested_old', 'nested_new'],
    ] as const) {
      expect(screen).toContain('[SEARCH & REPLACE]');
      expect(screen).toContain(`-${old}`);
      expect(screen).toContain(`+${next}`);
    }
  },
  120000,
);

it.skipIf(process.platform !== 'linux')(
  'the nearest-line hint is given only for files the caller may also read',
  async () => {
    // outside/ needs approval to edit and a separate grant to read; approving the edit grants no read.
    const { toolResults } = await captureApprovalPrompts({
      files: {
        'outside/secrets.env': 'AWS_SECRET_ACCESS_KEY=hunter2hunter2\nREGION=eu\n',
        'project/inside.env': 'PUBLIC_VALUE=visible_value_123\nMODE=dev\n',
      },
      calls: [
        [
          'search_replace',
          {
            path: '../outside/secrets.env',
            search_content: 'AWS_SECRET_ACCESS_KEY=hunter2hunter3',
            replace_content: 'x',
          },
        ],
        [
          'search_replace',
          { path: 'inside.env', search_content: 'PUBLIC_VALUE=visible_value_124', replace_content: 'x' },
        ],
      ],
      awaitText: ['hunter2hunter3'],
    });
    const joined = toolResults.join('\n');
    // Withheld: the plain not-found text, and none of the file's content.
    expect(joined).toContain('Search content not found');
    expect(joined).not.toContain('hunter2hunter2');
    expect(joined).not.toContain('REGION');
    // Allowed: inside the workspace the same hint is given.
    expect(joined).toContain('closest is line 1: "PUBLIC_VALUE=visible_value_123"');
  },
  120000,
);
