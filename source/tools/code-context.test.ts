import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import { createCodeContextSearchToolDefinition, createReadCodeOutlineToolDefinition } from './code-context.js';

async function withTempWorkspace(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(process.cwd(), '.term2-code-context-'));
  const workspaceDir = path.join(rootDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  process.cwd = () => workspaceDir;

  try {
    await run(workspaceDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

const readCodeOutlineToolDefinition = createReadCodeOutlineToolDefinition();
const codeContextSearchToolDefinition = createCodeContextSearchToolDefinition();

test.serial('needsApproval: code context tools are read-only', async (t) => {
  await withTempWorkspace(async () => {
    t.false(await readCodeOutlineToolDefinition.needsApproval({ path: 'src/example.ts' }));
    t.false(await codeContextSearchToolDefinition.needsApproval({ query_type: 'symbol', symbol: 'example' }));
  });
});

test.serial('schema: read_code_outline requires a path and rejects null', async (t) => {
  await withTempWorkspace(async () => {
    t.true(readCodeOutlineToolDefinition.parameters.safeParse({ path: 'src/example.ts' }).success);
    t.false(readCodeOutlineToolDefinition.parameters.safeParse({}).success);
    t.false(readCodeOutlineToolDefinition.parameters.safeParse({ path: null }).success);
  });
});

test.serial('schema: code_context_search enforces query-type-specific fields and optional max_results', async (t) => {
  await withTempWorkspace(async () => {
    t.true(
      codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related', path: 'src/example.ts' }).success,
    );
    t.false(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related' }).success);
    t.false(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related', path: null }).success);
    t.false(
      codeContextSearchToolDefinition.parameters.safeParse({
        query_type: 'related',
        path: 'src/example.ts',
        max_results: null,
      }).success,
    );

    t.true(
      codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol', symbol: 'buildThing' }).success,
    );
    t.false(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol' }).success);
    t.false(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol', symbol: null }).success);
    t.false(
      codeContextSearchToolDefinition.parameters.safeParse({
        query_type: 'symbol',
        symbol: 'buildThing',
        max_results: null,
      }).success,
    );
  });
});

test.serial('execute: read_code_outline summarizes a TS file without bodies', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.ts';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        "import fs from 'fs/promises';",
        "import { join } from 'path';",
        "const local = require('./local.js');",
        "const lazy = () => import('./lazy.js');",
        "export { helper } from './helper.js';",
        'export const value = 1;',
        'export function publicThing() {',
        "  return 'should-not-appear';",
        '}',
        'class InternalThing {',
        '  method() {',
        "    return 'also-hidden';",
        '  }',
        '}',
        'function localThing() {',
        "  return 'hidden-body';",
        '}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.ts'));
    t.true(result.includes('LANG typescript'));
    t.true(result.includes('IMPORTS'));
    t.true(result.includes('EXPORTS'));
    t.true(result.includes('DECLARATIONS'));
    t.regex(result, /fs\/promises/);
    t.regex(result, /path/);
    t.regex(result, /\.\/local\.js/);
    t.regex(result, /\.\/lazy\.js/);
    t.regex(result, /export const value line=\d+/);
    t.regex(result, /function publicThing line=\d+/);
    t.regex(result, /class InternalThing line=\d+/);
    t.false(result.includes('should-not-appear'));
    t.false(result.includes('also-hidden'));
    t.false(result.includes('hidden-body'));
  });
});

test.serial('execute: code_context_search related warns for unsupported target language', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'notes/outline.txt';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, 'plain text only');

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: filePath,
    });

    t.true(result.startsWith('WARNING unsupported_language'));
    t.true(result.includes('QUERY related'));
    t.true(result.includes('NO_RESULTS'));
  });
});

test.serial('execute: read_code_outline returns unknown language with empty sections', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'notes/outline.txt';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, 'plain text only');

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE notes/outline.txt'));
    t.true(result.includes('LANG unknown'));
    t.is((result.match(/\bEMPTY\b/g) ?? []).length, 3);
  });
});

test.serial('execute: code_context_search related finds tests, importers, and barrel exports', async (t) => {
  await withTempWorkspace(async (dir) => {
    const files: Array<[string, string]> = [
      ['src/foo.ts', ['export const foo = 1;', 'export function buildFoo() {', '  return foo;', '}'].join('\n')],
      ['src/foo.test.ts', ["import { foo } from './foo.js';", "test('foo', () => {", '  void foo;', '});'].join('\n')],
      ['src/index.ts', ["export * from './foo.js';"].join('\n')],
      ['src/consumer.ts', ["import { foo } from './foo.js';", 'console.log(foo);'].join('\n')],
    ];

    for (const [filePath, content] of files) {
      const absPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    }

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: 'src/foo.ts',
      max_results: 10,
    });

    t.true(result.includes('QUERY related'));
    t.true(result.includes('TARGET src/foo.ts'));
    t.true(result.includes('src/foo.test.ts'));
    t.true(result.includes('REL likely_test'));
    t.true(result.includes('src/index.ts'));
    t.true(result.includes('REL barrel_export'));
    t.true(result.includes('src/consumer.ts'));
    t.true(result.includes('REL imported_by_target'));
  });
});

test.serial('execute: code_context_search related honors max_results', async (t) => {
  await withTempWorkspace(async (dir) => {
    const files = [
      'src/foo.ts',
      'src/foo.test.ts',
      'src/foo.spec.ts',
      'src/index.ts',
      'src/consumer.ts',
      'src/another-consumer.ts',
    ];

    for (const filePath of files) {
      const absPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, "import { foo } from './foo.js';\nvoid foo;\n");
    }

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: 'src/foo.ts',
      max_results: 1,
    });

    const resultBlocks = result.split('\n\n').filter((part) => part.startsWith('src/'));
    t.true(resultBlocks.length <= 1);
    t.true(result.includes('src/foo.test.ts') || result.includes('src/foo.spec.ts'));
  });
});

test.serial('execute: code_context_search related detects multi-line named imports', async (t) => {
  await withTempWorkspace(async (dir) => {
    const files: Array<[string, string]> = [
      ['src/foo.ts', 'export const foo = 1;\n'],
      ['src/consumer.ts', ['import {', '  foo,', "} from './foo.js';", '', 'console.log(foo);'].join('\n')],
    ];

    for (const [filePath, content] of files) {
      const absPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    }

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: 'src/foo.ts',
    });

    t.true(result.includes('src/consumer.ts'));
    t.true(result.includes('REL imported_by_target'));
  });
});

test.serial('execute: code_context_search related does not flag same-named sibling modules', async (t) => {
  await withTempWorkspace(async (dir) => {
    const files: Array<[string, string]> = [
      ['src/a/util.ts', 'export const util = 1;\n'],
      ['src/a/consumer.ts', ["import { util } from './util.js';", 'void util;'].join('\n')],
      // src/b/other.ts imports its OWN sibling ./util, unrelated to src/a/util.ts
      ['src/b/util.ts', 'export const util = 2;\n'],
      ['src/b/other.ts', ["import { util } from './util.js';", 'void util;'].join('\n')],
    ];

    for (const [filePath, content] of files) {
      const absPath = path.join(dir, filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, content);
    }

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: 'src/a/util.ts',
    });

    t.true(result.includes('src/a/consumer.ts'));
    t.false(result.includes('src/b/other.ts'));
  });
});

const symbolCases = [
  {
    label: 'typescript',
    filePath: 'src/ts-example.ts',
    symbol: 'buildTsExample',
    content: [
      'export function buildTsExample() {',
      "  return 'ts';",
      '}',
      'function hiddenTsExample() {',
      "  return 'hidden';",
      '}',
    ].join('\n'),
    expectedKind: 'function',
    expectedExported: true,
  },
  {
    label: 'javascript',
    filePath: 'src/js-example.js',
    symbol: 'buildJsExample',
    content: ['export function buildJsExample() {', "  return 'js';", '}'].join('\n'),
    expectedKind: 'function',
    expectedExported: true,
  },
  {
    label: 'python',
    filePath: 'src/py-example.py',
    symbol: 'build_python_example',
    content: ['def build_python_example():', "    return 'py'"].join('\n'),
    expectedKind: 'function',
    expectedExported: false,
  },
  {
    label: 'go',
    filePath: 'src/go-example.go',
    symbol: 'BuildGoExample',
    content: ['package main', '', 'func BuildGoExample() {}'].join('\n'),
    expectedKind: 'function',
    expectedExported: true,
  },
  {
    label: 'rust',
    filePath: 'src/rs-example.rs',
    symbol: 'build_rust_example',
    content: ['pub fn build_rust_example() {}'].join('\n'),
    expectedKind: 'function',
    expectedExported: true,
  },
] as const;

for (const symbolCase of symbolCases) {
  test.serial(`execute: code_context_search symbol finds ${symbolCase.label} declarations`, async (t) => {
    await withTempWorkspace(async (dir) => {
      const absPath = path.join(dir, symbolCase.filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, symbolCase.content);

      const result = await codeContextSearchToolDefinition.execute({
        query_type: 'symbol',
        symbol: symbolCase.symbol,
      });

      t.true(result.includes(`QUERY symbol`));
      t.true(result.includes(`SYMBOL ${symbolCase.symbol}`));
      t.true(result.includes(symbolCase.filePath));
      t.regex(result, new RegExp(`${symbolCase.filePath}:\\d+ ${symbolCase.expectedKind} ${symbolCase.symbol}`));
      if (symbolCase.expectedExported) {
        t.true(result.includes('exported'));
      } else {
        t.false(result.includes('exported'));
      }
    });
  });
}

test.serial('execute: code_context_search rejects paths outside the workspace', async (t) => {
  await withTempWorkspace(async () => {
    const outlineResult = await readCodeOutlineToolDefinition.execute({ path: '../outside.ts' });
    const relatedResult = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: '../outside.ts',
    });

    t.true(outlineResult.includes('outside workspace'));
    t.true(relatedResult.includes('outside workspace'));
  });
});

test.serial('execute: code_context_search rejects unsafe symbol names', async (t) => {
  await withTempWorkspace(async () => {
    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'symbol',
      symbol: 'build.*',
    });

    t.true(result.startsWith('Error'));
    t.true(result.toLowerCase().includes('identifier'));
  });
});

test.serial('outline: inline type imports do not leak the type keyword into names', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/inline-type.ts';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        "import { type Foo, Bar } from './types';",
        "import { type Baz as Renamed, Qux } from './other';",
        'export const x = 1;',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    // 'type Foo' should not appear — only 'Foo'
    t.false(result.includes('type Foo'));
    t.true(result.includes('Foo'));
    t.true(result.includes('Bar'));

    // 'type Baz' should not appear — only 'Renamed' (the alias)
    t.false(result.includes('type Baz'));
    t.true(result.includes('Renamed'));
    t.true(result.includes('Qux'));
  });
});

test.serial('outline: async functions retain async in declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/async-fn.ts';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'export async function fetchData() {',
        "  return 'data';",
        '}',
        'async function internalFetch() {',
        "  return 'internal';",
        '}',
        'function syncThing() {',
        "  return 'sync';",
        '}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    // Async functions should show 'async function', not just 'function'
    t.true(result.includes('async function fetchData'));
    t.true(result.includes('async function internalFetch'));
    // Sync function stays as 'function'
    t.true(result.includes('function syncThing'));
  });
});

test.serial('outline: JSON files extract top-level keys as declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'package.json';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, JSON.stringify({ name: 'test', version: '1.0.0', scripts: { build: 'tsc' } }));

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('LANG json'));
    t.true(result.includes('name'));
    t.true(result.includes('version'));
    t.true(result.includes('scripts'));
  });
});
