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
  const [single] = await runScriptedRunCode({ scripts: [{ code: "await tools.read_file({path: 'missing.txt'});" }] });
  expect(single).toContain('tools.read_file failed (call 1 of 1, args {"path":"missing.txt"}): File not found');
});
