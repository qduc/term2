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

it('says once that the other calls are listed and that Promise.allSettled keeps them', async () => {
  const [result] = await runScriptedRunCode({
    files: { 'main.go': 'func main() {}\n', 'util.go': 'func util() {}\n' },
    scripts: [{ code: fanOutGrep }],
  });
  expect(result.match(/Promise\.allSettled/g)).toHaveLength(1);
  expect(result).toContain("The other calls' results are listed below");
  // a short completed result is shown, in dispatch order, next to its call
  expect(result).toMatch(/1\. grep \{[^}]*"main\.go"\} - ok, \d+ characters/);
  expect(result).toMatch(/2\. grep \{[^}]*"\*\.go"\} - FAILED \(error above\)/);
  expect(result).toMatch(/3\. grep \{[^}]*"util\.go"\} - ok, \d+ characters/);
  expect(result.indexOf('1:func main() {}')).toBeLessThan(result.indexOf('1:func util() {}'));
  // a single call that fails has no fan-out to explain
  const [single] = await runScriptedRunCode({ scripts: [{ code: "await tools.read_file({path: 'missing.txt'});" }] });
  expect(single).toContain('tools.read_file failed (call 1 of 1, args {"path":"missing.txt"})');
  expect(single).not.toContain('Promise.allSettled');
});

it('summarises a failed fan-out with large results as one line per call and a spooled file', async () => {
  const files = { 'a.txt': lines('a', 500), 'b.txt': lines('b', 500), 'c.txt': lines('c', 500) };
  let spooled = '';
  const [result] = await runScriptedRunCode({
    files,
    scripts: [
      {
        code: `return await Promise.all([
          tools.read_file({path: 'a.txt'}), tools.read_file({path: 'b.txt'}),
          tools.read_file({path: 'missing.txt'}), tools.read_file({path: 'c.txt'}),
        ]);`,
      },
    ],
    beforeCleanup: async (results) => {
      const path = /Full output saved to `([^`]+)`/.exec(results[0]!)?.[1];
      if (path) spooled = await readFile(path, 'utf8');
    },
  });
  expect(result.length).toBeLessThan(4_000);
  for (const name of ['a.txt', 'b.txt', 'c.txt']) {
    expect(result).toMatch(new RegExp(`read_file \\{"path":"${name}"\\} - ok, \\d+ characters`));
  }
  expect(result).toContain('read_file {"path":"missing.txt"} - FAILED (error above)');
  expect(result).toMatch(/Full output saved to `[^`]+` \(\d+ lines\)/);
  // the bodies are in the file, not in the message
  expect(result).not.toContain('a line 1 ');
  expect(spooled).toContain('=== call 1: read_file {"path":"a.txt"} ===');
  expect(spooled).toContain('=== call 4: read_file {"path":"c.txt"} ===');
  expect(spooled).toContain('c line 500 ');
  expect(spooled).not.toContain('missing.txt');
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
