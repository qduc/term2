import { expect, it } from 'vitest';
import { runScriptedRunCode } from './run-code-script-model.js';

/**
 * What the model reads from the file-search tools when they succeed, as the run_code script that calls them
 * returns it. `grep` and `glob` are offered to the model only inside run_code (`tools.grep`, `tools.glob`),
 * so each scenario is a scripted mock model issuing one script per case, and the assertions are on the
 * result text the next provider request carries: that text is the contract. The failure texts are in
 * run-code-failures.blackbox.ts.
 *
 * Every assertion holds for both search backends (ripgrep or grep for `grep`, fd or find for `glob`), because
 * which one is installed depends on the machine. Options that exist for one backend only (`no_ignore`), and
 * hidden or ignored files, are not exercised here for that reason.
 */

const FILES = {
  'a.txt': 'Hello World\nhello again\nbye\n',
  'regex.txt': 'a.b\naxb\n',
  'notes.log': 'hello log\n',
  'sub/b.txt': 'hello from b\n',
  'sub/c.md': 'hello from c\nHELLO LOUD\n',
  'src/deep/d.ts': 'export const hello = 1;\n',
  // Beside the workspace (the workspace is `<root>/project`), not in it.
  '../outside.txt': 'hello outside\n',
};

/** What a script returned: the text between the `Result:` heading and the tool-call footer. */
const returned = (result: string) => result.replace(/^Result:\n/, '').replace(/\n\n\[\d+ tool calls?: [^\]]*\]$/, '');
/** grep returns one `path:line:text` per line; backends differ in the order of files, not in the lines. */
const matchLines = (result: string) => returned(result).split('\n').sort();
/** glob returns `{ paths, total, truncated }`; backends differ in the order of paths. */
const globResult = (result: string) => {
  const value = JSON.parse(returned(result)) as { paths: string[]; total: number; truncated: boolean };
  return { ...value, paths: [...value.paths].sort() };
};

it('grep returns path:line:text for each match, and a search option narrows exactly what it names', async () => {
  const grep = (args: Record<string, unknown>) => `return await tools.grep(${JSON.stringify(args)});`;
  const results = await runScriptedRunCode({
    files: FILES,
    scripts: [
      { code: grep({ pattern: 'hello', path: '.' }) },
      { code: grep({ pattern: 'hello', path: '.', ignore_case: true }) },
      { code: grep({ pattern: 'a.b', path: '.', include: 'regex.txt' }) },
      { code: grep({ pattern: 'a.b', path: '.', include: 'regex.txt', fixed_strings: true }) },
      { code: grep({ pattern: 'hello', path: '.', include: '*.md' }) },
      { code: grep({ pattern: 'hello', path: '.', include: '*.{md,ts}' }) },
      { code: grep({ pattern: 'hello', path: '.', exclude: '*.{md,ts,log}' }) },
      { code: grep({ pattern: 'hello', path: 'sub' }) },
      { code: grep({ pattern: 'zzz-appears-nowhere', path: '.' }) },
    ],
  });
  const [plain, ignoreCase, regex, fixed, includeMd, includeBraces, exclude, subdirectory, none] = results as [
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
    string,
  ];

  // Case-sensitive by default: `Hello World` and `HELLO LOUD` do not match `hello`.
  expect(matchLines(plain)).toEqual([
    './a.txt:2:hello again',
    './notes.log:1:hello log',
    './src/deep/d.ts:1:export const hello = 1;',
    './sub/b.txt:1:hello from b',
    './sub/c.md:1:hello from c',
  ]);
  // ignore_case adds exactly the two lines that differ in case.
  expect(matchLines(ignoreCase)).toEqual([
    './a.txt:1:Hello World',
    './a.txt:2:hello again',
    './notes.log:1:hello log',
    './src/deep/d.ts:1:export const hello = 1;',
    './sub/b.txt:1:hello from b',
    './sub/c.md:1:hello from c',
    './sub/c.md:2:HELLO LOUD',
  ]);
  // A pattern is a regular expression unless fixed_strings is set: `a.b` also matches `axb`.
  expect(matchLines(regex).map((line) => line.replace(/^(\.\/regex\.txt:)?/, ''))).toEqual(['1:a.b', '2:axb']);
  expect(matchLines(fixed).map((line) => line.replace(/^(\.\/regex\.txt:)?/, ''))).toEqual(['1:a.b']);
  // include and exclude are file-name globs; braces list alternatives.
  expect(matchLines(includeMd)).toEqual(['./sub/c.md:1:hello from c']);
  expect(matchLines(includeBraces)).toEqual(['./src/deep/d.ts:1:export const hello = 1;', './sub/c.md:1:hello from c']);
  expect(matchLines(exclude)).toEqual(['./a.txt:2:hello again', './sub/b.txt:1:hello from b']);
  // A directory path searches that directory and names files relative to the workspace.
  expect(matchLines(subdirectory)).toEqual(['sub/b.txt:1:hello from b', 'sub/c.md:1:hello from c']);
  // No match is a sentence, not an empty string and not an error.
  expect(returned(none)).toBe('No matches found.');
});

it('glob returns { paths, total, truncated } relative to the search root', async () => {
  const glob = (args: Record<string, unknown>) => `return await tools.glob(${JSON.stringify(args)});`;
  const results = await runScriptedRunCode({
    files: FILES,
    scripts: [
      { code: glob({ pattern: '*.txt' }) },
      { code: glob({ pattern: '*.txt', path: 'sub' }) },
      { code: glob({ pattern: 'sub/*.md' }) },
      { code: glob({ pattern: 'src/**/*.ts' }) },
      { code: glob({ pattern: '*.txt', max_results: 2 }) },
      { code: glob({ pattern: '*.zzz' }) },
    ],
  });
  const [byName, inDirectory, withDirectory, recursive, capped, none] = results.map(globResult) as [
    ReturnType<typeof globResult>,
    ReturnType<typeof globResult>,
    ReturnType<typeof globResult>,
    ReturnType<typeof globResult>,
    ReturnType<typeof globResult>,
    ReturnType<typeof globResult>,
  ];

  // A bare name pattern is matched at every depth of the workspace, never in the folder beside it.
  expect(byName).toEqual({ paths: ['a.txt', 'regex.txt', 'sub/b.txt'], total: 3, truncated: false });
  // `path` is the search root: results are named relative to it.
  expect(inDirectory).toEqual({ paths: ['b.txt'], total: 1, truncated: false });
  expect(withDirectory).toEqual({ paths: ['sub/c.md'], total: 1, truncated: false });
  expect(recursive).toEqual({ paths: ['src/deep/d.ts'], total: 1, truncated: false });
  // max_results caps the list, and the result says it did and how many there were.
  expect(capped.paths).toHaveLength(2);
  expect(capped.total).toBe(3);
  expect(capped.truncated).toBe(true);
  expect(byName.paths).toEqual(expect.arrayContaining(capped.paths));
  // No match is an empty list the script can count, not prose it would split into paths.
  expect(none).toEqual({ paths: [], total: 0, truncated: false });
});

it('grep and glob stay inside the workspace: outside paths are refused and never searched from within', async () => {
  const refusal = (tool: string) =>
    `Refused (needs user approval and could not be completed from inside this script): ${tool}`;
  const results = await runScriptedRunCode({
    // The product's own approval policy: --auto-approve would approve reads outside the workspace too.
    approval: 'default',
    files: FILES,
    scripts: [
      { code: "return await tools.grep({ pattern: 'hello', path: '.' });" },
      { code: "return await tools.grep({ pattern: 'hello outside', path: '.' });" },
      { code: "return await tools.glob({ pattern: '*.txt' });" },
      { code: "return await tools.glob({ pattern: '../*.txt' });" },
      { code: "return await tools.grep({ pattern: 'hello', path: '..' });" },
      { code: "return await tools.grep({ pattern: 'hello', path: 'sub/../..' });" },
      { code: "return await tools.grep({ pattern: 'localhost', path: '/etc/hosts' });" },
      { code: "return await tools.glob({ pattern: '*.txt', path: '..' });" },
      { code: "return await tools.glob({ pattern: '/etc/host*' });" },
    ],
  });
  const [
    inside,
    notFromInside,
    globInside,
    globDotDot,
    grepParent,
    grepRoundTrip,
    grepAbsolute,
    globParent,
    globAbsolute,
  ] = results as [string, string, string, string, string, string, string, string, string];

  // Inside the workspace both tools run without an approval, and the sibling folder's file is not in their results.
  expect(matchLines(inside)).toContain('./a.txt:2:hello again');
  expect(inside).not.toContain('outside.txt');
  expect(returned(notFromInside)).toBe('No matches found.');
  expect(globResult(globInside).paths).toEqual(['a.txt', 'regex.txt', 'sub/b.txt']);
  // A `..` inside a pattern does not move the search root out of the workspace.
  expect(JSON.stringify(globResult(globDotDot).paths)).not.toContain('outside.txt');
  expect(globResult(globDotDot).paths.every((path) => !path.startsWith('..') && !path.startsWith('/'))).toBe(true);

  // A path that resolves outside the workspace needs approval, and a headless run cannot give it:
  // the call fails, says so, and nothing outside is read.
  for (const [result, tool] of [
    [grepParent, 'grep'],
    [grepRoundTrip, 'grep'],
    [grepAbsolute, 'grep'],
    [globParent, 'glob'],
    [globAbsolute, 'glob'],
  ] as const) {
    expect(result).toContain('Tool execution was not approved');
    expect(result).toContain(refusal(tool));
    expect(result).not.toMatch(/^Result:/);
    // No match line (`path:line:text`, or `line:text` for a file) and no file name from the sibling folder.
    expect(result).not.toMatch(/\n\d+:|\.txt:\d+:/);
    expect(result).not.toContain('outside.txt');
  }
});
