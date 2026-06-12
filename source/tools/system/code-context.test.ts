import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createCodeContextSearchToolDefinition, createReadCodeOutlineToolDefinition } from './code-context.js';

async function withTempWorkspace(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-code-context-'));
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
    const outlineResult = await readCodeOutlineToolDefinition.execute({ path: '/etc/outside.ts' });
    const relatedResult = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: '/etc/outside.ts',
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

test.serial('outline: Python files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.py';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'import os',
        'from sys import argv',
        'from collections import (',
        '    defaultdict,',
        '    OrderedDict as OD',
        ')',
        '# some comment def hidden',
        'class MyClass:',
        '    def nested_method(self):',
        '        pass',
        'def my_func():',
        '    pass',
        'async def my_async_func():',
        '    pass',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.py'));
    t.true(result.includes('LANG python'));
    t.true(result.includes('IMPORTS'));
    t.true(result.includes('DECLARATIONS'));
    t.regex(result, /os: os/);
    t.regex(result, /sys: argv/);
    t.regex(result, /collections: defaultdict OD/);
    t.regex(result, /class MyClass/);
    t.regex(result, /function my_func/);
    t.regex(result, /async function my_async_func/);
    t.false(result.includes('nested_method')); // nested method is indented
  });
});

test.serial('outline: Go files extract imports and declarations with visibility', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.go';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'package main',
        'import "fmt"',
        'import (',
        '    "os"',
        '    "path/filepath"',
        '    alias "net/http"',
        ')',
        'type MyStruct struct{}',
        'type MyInterface interface{}',
        'const MyConst = 42',
        'var MyVar = "hello"',
        'const (',
        '    Const1 = 1',
        '    const2 = 2',
        ')',
        'var (',
        '    Var1 = 1',
        '    var2 = 2',
        ')',
        'func ExportedFunc() {}',
        'func privateFunc() {}',
        'func (m *MyStruct) Method() {}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.go'));
    t.true(result.includes('LANG go'));
    t.true(result.includes('IMPORTS'));
    t.true(result.includes('EXPORTS'));
    t.true(result.includes('DECLARATIONS'));

    t.regex(result, /fmt: side-effect/);
    t.regex(result, /os: side-effect/);
    t.regex(result, /path\/filepath: side-effect/);
    t.regex(result, /net\/http: alias/);

    t.regex(result, /type MyStruct line=\d+ exported/);
    t.regex(result, /interface MyInterface line=\d+ exported/);
    t.regex(result, /const MyConst line=\d+ exported/);
    t.regex(result, /var MyVar line=\d+ exported/);
    t.regex(result, /const Const1 line=\d+ exported/);
    t.regex(result, /const const2 line=\d+\s*$/m); // not exported
    t.regex(result, /var Var1 line=\d+ exported/);
    t.regex(result, /var var2 line=\d+\s*$/m); // not exported
    t.regex(result, /function ExportedFunc line=\d+ exported/);
    t.regex(result, /function privateFunc line=\d+\s*$/m); // not exported
    t.regex(result, /method Method line=\d+ exported/);

    // exports
    t.regex(result, /export type MyStruct line=\d+/);
    t.regex(result, /export interface MyInterface line=\d+/);
    t.regex(result, /export const MyConst line=\d+/);
    t.regex(result, /export var MyVar line=\d+/);
    t.regex(result, /export const Const1 line=\d+/);
    t.regex(result, /export var Var1 line=\d+/);
    t.regex(result, /export function ExportedFunc line=\d+/);
    t.regex(result, /export method Method line=\d+/);
    t.false(result.includes('const2 line=') && result.includes('export const const2'));
  });
});

test.serial('outline: Rust files extract imports and declarations with visibility', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.rs';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'use std::collections::HashMap;',
        'pub use std::io::{self, Write};',
        'use std::fs as my_fs;',
        'pub struct PublicStruct;',
        'struct PrivateStruct;',
        'pub enum PublicEnum {}',
        'pub trait PublicTrait {}',
        'pub type PublicType = i32;',
        'pub const MY_CONST: i32 = 123;',
        'pub fn public_fn() {}',
        'fn private_fn() {}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.rs'));
    t.true(result.includes('LANG rust'));
    t.true(result.includes('IMPORTS'));
    t.true(result.includes('EXPORTS'));
    t.true(result.includes('DECLARATIONS'));

    t.regex(result, /std::collections: HashMap/);
    t.regex(result, /std::io: self Write/);
    t.regex(result, /std: my_fs/);

    t.regex(result, /type PublicStruct line=\d+ exported/);
    t.regex(result, /type PrivateStruct line=\d+\s*$/m); // not exported
    t.regex(result, /enum PublicEnum line=\d+ exported/);
    t.regex(result, /interface PublicTrait line=\d+ exported/);
    t.regex(result, /type PublicType line=\d+ exported/);
    t.regex(result, /const MY_CONST line=\d+ exported/);
    t.regex(result, /function public_fn line=\d+ exported/);
    t.regex(result, /function private_fn line=\d+\s*$/m); // not exported

    // exports
    t.regex(result, /export type PublicStruct line=\d+/);
    t.regex(result, /export enum PublicEnum line=\d+/);
    t.regex(result, /export interface PublicTrait line=\d+/);
    t.regex(result, /export type PublicType line=\d+/);
    t.regex(result, /export const MY_CONST line=\d+/);
    t.regex(result, /export function public_fn line=\d+/);
  });
});

test.serial('outline: Java files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/Example.java';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'package com.example;',
        'import java.util.List;',
        'import static org.junit.Assert.assertEquals;',
        'public class Example {',
        '    public Example() {}',
        '    public void doSomething() {}',
        '    private String calculate() { return "java"; }',
        '}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/Example.java'));
    t.true(result.includes('LANG java'));
    t.regex(result, /java.util.List: List line=2/);
    t.regex(result, /org.junit.Assert.assertEquals: assertEquals line=3/);
    t.regex(result, /class Example line=4 exported/);
    t.regex(result, /method Example line=5 exported/);
    t.regex(result, /method doSomething line=6 exported/);
    t.regex(result, /method calculate line=7/);
    t.false(result.includes('method calculate line=7 exported'));
  });
});

test.serial('outline: C# files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/Example.cs';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        'using System;',
        'using System.Collections.Generic;',
        'namespace App {',
        '    public class Example {',
        '        public Example() {}',
        '        public void DoSomething() {}',
        '        private string GetName() { return "cs"; }',
        '    }',
        '    public struct MyStruct {}',
        '}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/Example.cs'));
    t.true(result.includes('LANG csharp'));
    t.regex(result, /System: System line=1/);
    t.regex(result, /System.Collections.Generic: Generic line=2/);
    t.regex(result, /class Example line=4 exported/);
    t.regex(result, /method Example line=5 exported/);
    t.regex(result, /method DoSomething line=6 exported/);
    t.regex(result, /method GetName line=7/);
    t.regex(result, /class MyStruct line=9 exported/);
  });
});

test.serial('outline: C/C++ files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.cpp';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        '#include <vector>',
        '#include "helper.h"',
        'struct Point {',
        '    int x;',
        '};',
        'class Calculator {',
        'public:',
        '    int add(int a, int b) { return a + b; }',
        '};',
        'int main() {',
        '    return 0;',
        '}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.cpp'));
    t.true(result.includes('LANG cpp'));
    t.regex(result, /<vector>: side-effect line=1/);
    t.regex(result, /\.\/helper.h: side-effect line=2/);
    t.regex(result, /class Point line=3 exported/);
    t.regex(result, /class Calculator line=6 exported/);
    t.regex(result, /method add line=8 exported/);
    t.regex(result, /function main line=10 exported/);
  });
});

test.serial('outline: Ruby files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.rb';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        "require 'json'",
        "require_relative 'helper'",
        'module MyModule',
        '    class MyClass',
        '    end',
        'end',
        'def top_level_method',
        'end',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.rb'));
    t.true(result.includes('LANG ruby'));
    t.regex(result, /json: side-effect line=1/);
    t.regex(result, /helper: side-effect line=2/);
    t.regex(result, /class MyModule line=3 exported/);
    t.regex(result, /class MyClass line=4 exported/);
    t.regex(result, /function top_level_method line=7 exported/);
  });
});

test.serial('outline: PHP files extract imports and declarations', async (t) => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'src/example.php';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(
      absPath,
      [
        '<?php',
        'namespace App\\Core;',
        'use App\\Utils\\Helper;',
        'class Controller {',
        '    public function index() {}',
        '}',
        'interface Service {}',
        'function global_func() {}',
      ].join('\n'),
    );

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    t.true(result.includes('FILE src/example.php'));
    t.true(result.includes('LANG php'));
    t.regex(result, /App\\Core: side-effect line=2/);
    t.regex(result, /App\\Utils\\Helper: side-effect line=3/);
    t.regex(result, /class Controller line=4 exported/);
    t.regex(result, /function index line=5 exported/);
    t.regex(result, /interface Service line=7 exported/);
    t.regex(result, /function global_func line=8 exported/);
  });
});
