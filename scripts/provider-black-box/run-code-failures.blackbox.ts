import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { runScriptedRunCode } from './run-code-script-model.js';

/**
 * What the model reads when a run_code script fails. Each scenario is a scripted
 * mock model issuing the failing script; the assertions are on the result text the
 * next provider request carries, because that text is the contract.
 */

const lines = (label: string, count: number) =>
  Array.from({ length: count }, (_, index) => `${label} line ${index + 1} ${'x'.repeat(40)}`).join('\n');

const fanOutGrep = `
const r = await Promise.all([
  tools.grep({pattern: 'func', path: 'main.go'}),
  tools.grep({pattern: 'func', path: '*.go'}),
  tools.grep({pattern: 'func', path: 'util.go'}),
]);
return r;`;

it('names the failing call and its arguments when one call of a fan-out fails', async () => {
  const [result] = await runScriptedRunCode({
    files: { 'main.go': 'func main() {}\n', 'util.go': 'func util() {}\n' },
    scripts: [{ code: fanOutGrep }],
  });
  // which call, of how many, with which arguments, and the underlying error
  expect(result).toContain('tools.grep failed (call 2 of 3, args {"pattern":"func","path":"*.go"}): Search failed:');
  expect(result).toContain('No such file or directory');
  // the actionable hint
  expect(result).toContain('path "*.go" is a glob pattern, not a path; pass it as include: "*.go"');
  const [single] = await runScriptedRunCode({ scripts: [{ code: "await tools.read_file({path: 'missing.txt'});" }] });
  expect(single).toContain('tools.read_file failed (call 1 of 1, args {"path":"missing.txt"}): File not found');
});

it('explains a glob path to the direct read_file tool and to scripted glob', async () => {
  // grep and glob are not directly callable under this model profile; their hint is the same
  // tool code the scripted scenarios above exercise.
  const [read, glob] = await runScriptedRunCode({
    files: { 'main.go': 'func main() {}\n' },
    scripts: [
      { tool: 'read_file', args: { path: '*.go' } },
      { code: "await tools.glob({pattern: '*.go', path: '*.go'});" },
    ],
  });
  expect(read).toContain('read_file reads one exact file');
  expect(read).toContain('pattern: "*.go"');
  expect(glob).toContain('path "*.go" is a glob pattern, not a directory; pass it as pattern: "*.go"');
});

it('does not invent a glob hint for a missing path that is not a pattern', async () => {
  const [result] = await runScriptedRunCode({
    scripts: [{ code: "await tools.grep({pattern: 'x', path: 'nope'});" }],
  });
  expect(result).toContain('tools.grep failed (call 1 of 1, args {"pattern":"x","path":"nope"})');
  expect(result).not.toContain('glob pattern');
});
