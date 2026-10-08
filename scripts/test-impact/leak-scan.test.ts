import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, expect, it } from 'vitest';
import { files, scanFile } from './leak-scan.mjs';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'term2-leak-scan-test-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function rulesFor(source: string): string[] {
  const file = path.join(dir, `fixture-${Math.random().toString(36).slice(2)}.test.ts`);
  fs.writeFileSync(file, source);
  return [...new Set(scanFile(file).map((f: { rule: string }) => f.rule))].sort();
}

it('flags replacing the environment object', () => {
  expect(rulesFor(`const prev = { ...process.env };\nprocess.env = prev;\n`)).toEqual(['env-swap']);
});

it('flags writes under the working directory but not under the OS temp dir', () => {
  expect(rulesFor(`import fs from 'node:fs';\nfs.mkdirSync(path.join(process.cwd(), 'scratch'));\n`)).toEqual([
    'repo-write',
  ]);
  expect(
    rulesFor(
      `import fs from 'node:fs';\nconst d = fs.mkdtempSync(path.join(os.tmpdir(), 'x-'));\nfs.writeFileSync(path.join(d, 'a'), '');\n`,
    ),
  ).toEqual([]);
});

it('flags a working-directory change', () => {
  expect(rulesFor(`process.chdir('/tmp');\n`)).toEqual(['chdir']);
});

it('does not flag a fixed prefix passed to mkdtemp, which always gets a random suffix', () => {
  expect(rulesFor(`import fs from 'node:fs';\nfs.mkdtempSync('/tmp/acp-backend-');\n`)).toEqual([]);
});

it('does not flag the React act flag or a regex exec', () => {
  expect(rulesFor(`globalThis.IS_REACT_ACT_ENVIRONMENT = true;\nconst m = /a(\\d)/.exec('a1');\n`)).toEqual([]);
});

it('flags a replaced fetch unless the original is captured and put back', () => {
  expect(rulesFor(`globalThis.fetch = (() => {}) as any;\n`)).toEqual(['patch']);
  expect(
    rulesFor(
      `const originalFetch = globalThis.fetch;\nglobalThis.fetch = (() => {}) as any;\nglobalThis.fetch = originalFetch;\n`,
    ),
  ).toEqual([]);
});

it('honours a reviewed suppression on the line or for the whole file', () => {
  expect(rulesFor(`// leak-scan-allow env-swap: restored in finally\nprocess.env = {};\n`)).toEqual([]);
  expect(rulesFor(`// leak-scan-allow-file chdir: restores the cwd in afterEach\nprocess.chdir('/tmp');\n`)).toEqual(
    [],
  );
  // a suppression for a different rule does not hide this one
  expect(rulesFor(`// leak-scan-allow chdir: unrelated\nprocess.env = {};\n`)).toEqual(['env-swap']);
});

// The point of the scanner: a new test that would leak process state into the next file in a
// shared worker (vitest.shared.config.ts / vitest.hybrid.config.ts) fails here, at review time,
// instead of surfacing as an intermittent failure in a shuffled campaign. A real exception is
// marked with `// leak-scan-allow <rule>: <why>` next to the code.
it('finds no unreviewed process-state leak in any unit test file', () => {
  const found: string[] = [];
  for (const file of files()) {
    for (const f of scanFile(file)) found.push(`${file}:${f.line} ${f.rule} ${f.detail}`);
  }
  expect(found).toEqual([]);
});
