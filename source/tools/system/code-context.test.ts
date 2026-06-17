import { it, expect } from 'vitest';
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

it.sequential('needsApproval: code context tools are read-only', async () => {
  await withTempWorkspace(async () => {
    expect(await readCodeOutlineToolDefinition.needsApproval({ path: 'src/example.ts' })).toBe(false);
    expect(await codeContextSearchToolDefinition.needsApproval({ query_type: 'symbol', symbol: 'example' })).toBe(
      false,
    );
  });
});

it.sequential('schema: read_code_outline requires a path and rejects null', async () => {
  await withTempWorkspace(async () => {
    expect(readCodeOutlineToolDefinition.parameters.safeParse({ path: 'src/example.ts' }).success).toBe(true);
    expect(readCodeOutlineToolDefinition.parameters.safeParse({}).success).toBe(false);
    expect(readCodeOutlineToolDefinition.parameters.safeParse({ path: null }).success).toBe(false);
  });
});

it.sequential('schema: code_context_search enforces query-type-specific fields and optional max_results', async () => {
  await withTempWorkspace(async () => {
    expect(
      codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related', path: 'src/example.ts' }).success,
    ).toBe(true);
    expect(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related' }).success).toBe(false);
    expect(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'related', path: null }).success).toBe(
      false,
    );
    expect(
      codeContextSearchToolDefinition.parameters.safeParse({
        query_type: 'related',
        path: 'src/example.ts',
        max_results: null,
      }).success,
    ).toBe(false);

    expect(
      codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol', symbol: 'buildThing' }).success,
    ).toBe(true);
    expect(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol' }).success).toBe(false);
    expect(codeContextSearchToolDefinition.parameters.safeParse({ query_type: 'symbol', symbol: null }).success).toBe(
      false,
    );
    expect(
      codeContextSearchToolDefinition.parameters.safeParse({
        query_type: 'symbol',
        symbol: 'buildThing',
        max_results: null,
      }).success,
    ).toBe(false);
  });
});

it.sequential('execute: read_code_outline summarizes a TS file without bodies', async () => {
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

    expect(result.includes('FILE src/example.ts')).toBe(true);
    expect(result.includes('LANG typescript')).toBe(true);
    expect(result.includes('IMPORTS')).toBe(true);
    expect(result.includes('EXPORTS')).toBe(true);
    expect(result.includes('DECLARATIONS')).toBe(true);
    expect(result).toMatch(/fs\/promises/);
    expect(result).toMatch(/path/);
    expect(result).toMatch(/\.\/local\.js/);
    expect(result).toMatch(/\.\/lazy\.js/);
    expect(result).toMatch(/export const value line=\d+/);
    expect(result).toMatch(/function publicThing line=\d+/);
    expect(result).toMatch(/class InternalThing line=\d+/);
    expect(result.includes('should-not-appear')).toBe(false);
    expect(result.includes('also-hidden')).toBe(false);
    expect(result.includes('hidden-body')).toBe(false);
  });
});

it.sequential('execute: code_context_search related warns for unsupported target language', async () => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'notes/outline.txt';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, 'plain text only');

    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: filePath,
    });

    expect(result.startsWith('WARNING unsupported_language')).toBe(true);
    expect(result.includes('QUERY related')).toBe(true);
    expect(result.includes('NO_RESULTS')).toBe(true);
  });
});

it.sequential('execute: read_code_outline returns unknown language with empty sections', async () => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'notes/outline.txt';
    const absPath = path.join(dir, filePath);
    await fs.mkdir(path.dirname(absPath), { recursive: true });
    await fs.writeFile(absPath, 'plain text only');

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    expect(result.includes('FILE notes/outline.txt')).toBe(true);
    expect(result.includes('LANG unknown')).toBe(true);
    expect((result.match(/\bEMPTY\b/g) ?? []).length).toBe(3);
  });
});

it.sequential('execute: code_context_search related finds tests, importers, and barrel exports', async () => {
  await withTempWorkspace(async (dir) => {
    const files: Array<[string, string]> = [
      ['src/foo.ts', ['export const foo = 1;', 'export function buildFoo() {', '  return foo;', '}'].join('\n')],
      ['src/foo.test.ts', ["import { foo } from './foo.js';", "it('foo', () => {", '  void foo;', '});'].join('\n')],
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

    expect(result.includes('QUERY related')).toBe(true);
    expect(result.includes('TARGET src/foo.ts')).toBe(true);
    expect(result.includes('src/foo.test.ts')).toBe(true);
    expect(result.includes('REL likely_test')).toBe(true);
    expect(result.includes('src/index.ts')).toBe(true);
    expect(result.includes('REL barrel_export')).toBe(true);
    expect(result.includes('src/consumer.ts')).toBe(true);
    expect(result.includes('REL imported_by_target')).toBe(true);
  });
});

it.sequential('execute: code_context_search related honors max_results', async () => {
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

    const resultBlocks = result.split('\n\n').filter((part: string) => part.startsWith('src/'));
    expect(resultBlocks.length <= 1).toBe(true);
    expect(result.includes('src/foo.test.ts') || result.includes('src/foo.spec.ts')).toBe(true);
  });
});

it.sequential('execute: code_context_search related detects multi-line named imports', async () => {
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

    expect(result.includes('src/consumer.ts')).toBe(true);
    expect(result.includes('REL imported_by_target')).toBe(true);
  });
});

it.sequential('execute: code_context_search related does not flag same-named sibling modules', async () => {
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

    expect(result.includes('src/a/consumer.ts')).toBe(true);
    expect(result.includes('src/b/other.ts')).toBe(false);
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
  it.sequential(`execute: code_context_search symbol finds ${symbolCase.label} declarations`, async () => {
    await withTempWorkspace(async (dir) => {
      const absPath = path.join(dir, symbolCase.filePath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });
      await fs.writeFile(absPath, symbolCase.content);

      const result = await codeContextSearchToolDefinition.execute({
        query_type: 'symbol',
        symbol: symbolCase.symbol,
      });

      expect(result.includes(`QUERY symbol`)).toBe(true);
      expect(result.includes(`SYMBOL ${symbolCase.symbol}`)).toBe(true);
      expect(result.includes(symbolCase.filePath)).toBe(true);
      expect(result).toMatch(new RegExp(`${symbolCase.filePath}:\\d+ ${symbolCase.expectedKind} ${symbolCase.symbol}`));
      if (symbolCase.expectedExported) {
        expect(result.includes('exported')).toBe(true);
      } else {
        expect(result.includes('exported')).toBe(false);
      }
    });
  });
}

it.sequential('execute: code_context_search rejects paths outside the workspace', async () => {
  await withTempWorkspace(async () => {
    const outlineResult = await readCodeOutlineToolDefinition.execute({ path: '/etc/outside.ts' });
    const relatedResult = await codeContextSearchToolDefinition.execute({
      query_type: 'related',
      path: '/etc/outside.ts',
    });

    expect(outlineResult.includes('outside workspace')).toBe(true);
    expect(relatedResult.includes('outside workspace')).toBe(true);
  });
});

it.sequential('execute: code_context_search rejects unsafe symbol names', async () => {
  await withTempWorkspace(async () => {
    const result = await codeContextSearchToolDefinition.execute({
      query_type: 'symbol',
      symbol: 'build.*',
    });

    expect(result.startsWith('Error')).toBe(true);
    expect(result.toLowerCase().includes('identifier')).toBe(true);
  });
});

it.sequential('outline: inline type imports do not leak the type keyword into names', async () => {
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
    expect(result.includes('type Foo')).toBe(false);
    expect(result.includes('Foo')).toBe(true);
    expect(result.includes('Bar')).toBe(true);

    // 'type Baz' should not appear — only 'Renamed' (the alias)
    expect(result.includes('type Baz')).toBe(false);
    expect(result.includes('Renamed')).toBe(true);
    expect(result.includes('Qux')).toBe(true);
  });
});

it.sequential('outline: async functions retain async in declarations', async () => {
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
    expect(result.includes('async function fetchData')).toBe(true);
    expect(result.includes('async function internalFetch')).toBe(true);
    // Sync function stays as 'function'
    expect(result.includes('function syncThing')).toBe(true);
  });
});

it.sequential('outline: JSON files extract top-level keys as declarations', async () => {
  await withTempWorkspace(async (dir) => {
    const filePath = 'package.json';
    const absPath = path.join(dir, filePath);
    await fs.writeFile(absPath, JSON.stringify({ name: 'test', version: '1.0.0', scripts: { build: 'tsc' } }));

    const result = await readCodeOutlineToolDefinition.execute({ path: filePath });

    expect(result.includes('LANG json')).toBe(true);
    expect(result.includes('name')).toBe(true);
    expect(result.includes('version')).toBe(true);
    expect(result.includes('scripts')).toBe(true);
  });
});

it.sequential('outline: Python files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/example.py')).toBe(true);
    expect(result.includes('LANG python')).toBe(true);
    expect(result.includes('IMPORTS')).toBe(true);
    expect(result.includes('DECLARATIONS')).toBe(true);
    expect(result).toMatch(/os: os/);
    expect(result).toMatch(/sys: argv/);
    expect(result).toMatch(/collections: defaultdict OD/);
    expect(result).toMatch(/class MyClass/);
    expect(result).toMatch(/function my_func/);
    expect(result).toMatch(/async function my_async_func/);
    expect(result.includes('nested_method')).toBe(false); // nested method is indented
  });
});

it.sequential('outline: Go files extract imports and declarations with visibility', async () => {
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

    expect(result.includes('FILE src/example.go')).toBe(true);
    expect(result.includes('LANG go')).toBe(true);
    expect(result.includes('IMPORTS')).toBe(true);
    expect(result.includes('EXPORTS')).toBe(true);
    expect(result.includes('DECLARATIONS')).toBe(true);

    expect(result).toMatch(/fmt: side-effect/);
    expect(result).toMatch(/os: side-effect/);
    expect(result).toMatch(/path\/filepath: side-effect/);
    expect(result).toMatch(/net\/http: alias/);

    expect(result).toMatch(/type MyStruct line=\d+ exported/);
    expect(result).toMatch(/interface MyInterface line=\d+ exported/);
    expect(result).toMatch(/const MyConst line=\d+ exported/);
    expect(result).toMatch(/var MyVar line=\d+ exported/);
    expect(result).toMatch(/const Const1 line=\d+ exported/);
    expect(result).toMatch(/const const2 line=\d+\s*$/m); // not exported
    expect(result).toMatch(/var Var1 line=\d+ exported/);
    expect(result).toMatch(/var var2 line=\d+\s*$/m); // not exported
    expect(result).toMatch(/function ExportedFunc line=\d+ exported/);
    expect(result).toMatch(/function privateFunc line=\d+\s*$/m); // not exported
    expect(result).toMatch(/method Method line=\d+ exported/);

    // exports
    expect(result).toMatch(/export type MyStruct line=\d+/);
    expect(result).toMatch(/export interface MyInterface line=\d+/);
    expect(result).toMatch(/export const MyConst line=\d+/);
    expect(result).toMatch(/export var MyVar line=\d+/);
    expect(result).toMatch(/export const Const1 line=\d+/);
    expect(result).toMatch(/export var Var1 line=\d+/);
    expect(result).toMatch(/export function ExportedFunc line=\d+/);
    expect(result).toMatch(/export method Method line=\d+/);
    expect(result.includes('const2 line=') && result.includes('export const const2')).toBe(false);
  });
});

it.sequential('outline: Rust files extract imports and declarations with visibility', async () => {
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

    expect(result.includes('FILE src/example.rs')).toBe(true);
    expect(result.includes('LANG rust')).toBe(true);
    expect(result.includes('IMPORTS')).toBe(true);
    expect(result.includes('EXPORTS')).toBe(true);
    expect(result.includes('DECLARATIONS')).toBe(true);

    expect(result).toMatch(/std::collections: HashMap/);
    expect(result).toMatch(/std::io: self Write/);
    expect(result).toMatch(/std: my_fs/);

    expect(result).toMatch(/type PublicStruct line=\d+ exported/);
    expect(result).toMatch(/type PrivateStruct line=\d+\s*$/m); // not exported
    expect(result).toMatch(/enum PublicEnum line=\d+ exported/);
    expect(result).toMatch(/interface PublicTrait line=\d+ exported/);
    expect(result).toMatch(/type PublicType line=\d+ exported/);
    expect(result).toMatch(/const MY_CONST line=\d+ exported/);
    expect(result).toMatch(/function public_fn line=\d+ exported/);
    expect(result).toMatch(/function private_fn line=\d+\s*$/m); // not exported

    // exports
    expect(result).toMatch(/export type PublicStruct line=\d+/);
    expect(result).toMatch(/export enum PublicEnum line=\d+/);
    expect(result).toMatch(/export interface PublicTrait line=\d+/);
    expect(result).toMatch(/export type PublicType line=\d+/);
    expect(result).toMatch(/export const MY_CONST line=\d+/);
    expect(result).toMatch(/export function public_fn line=\d+/);
  });
});

it.sequential('outline: Java files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/Example.java')).toBe(true);
    expect(result.includes('LANG java')).toBe(true);
    expect(result).toMatch(/java.util.List: List line=2/);
    expect(result).toMatch(/org.junit.Assert.assertEquals: assertEquals line=3/);
    expect(result).toMatch(/class Example line=4 exported/);
    expect(result).toMatch(/method Example line=5 exported/);
    expect(result).toMatch(/method doSomething line=6 exported/);
    expect(result).toMatch(/method calculate line=7/);
    expect(result.includes('method calculate line=7 exported')).toBe(false);
  });
});

it.sequential('outline: C# files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/Example.cs')).toBe(true);
    expect(result.includes('LANG csharp')).toBe(true);
    expect(result).toMatch(/System: System line=1/);
    expect(result).toMatch(/System.Collections.Generic: Generic line=2/);
    expect(result).toMatch(/class Example line=4 exported/);
    expect(result).toMatch(/method Example line=5 exported/);
    expect(result).toMatch(/method DoSomething line=6 exported/);
    expect(result).toMatch(/method GetName line=7/);
    expect(result).toMatch(/class MyStruct line=9 exported/);
  });
});

it.sequential('outline: C/C++ files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/example.cpp')).toBe(true);
    expect(result.includes('LANG cpp')).toBe(true);
    expect(result).toMatch(/<vector>: side-effect line=1/);
    expect(result).toMatch(/\.\/helper.h: side-effect line=2/);
    expect(result).toMatch(/class Point line=3 exported/);
    expect(result).toMatch(/class Calculator line=6 exported/);
    expect(result).toMatch(/method add line=8 exported/);
    expect(result).toMatch(/function main line=10 exported/);
  });
});

it.sequential('outline: Ruby files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/example.rb')).toBe(true);
    expect(result.includes('LANG ruby')).toBe(true);
    expect(result).toMatch(/json: side-effect line=1/);
    expect(result).toMatch(/helper: side-effect line=2/);
    expect(result).toMatch(/class MyModule line=3 exported/);
    expect(result).toMatch(/class MyClass line=4 exported/);
    expect(result).toMatch(/function top_level_method line=7 exported/);
  });
});

it.sequential('outline: PHP files extract imports and declarations', async () => {
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

    expect(result.includes('FILE src/example.php')).toBe(true);
    expect(result.includes('LANG php')).toBe(true);
    expect(result).toMatch(/App\\Core: side-effect line=2/);
    expect(result).toMatch(/App\\Utils\\Helper: side-effect line=3/);
    expect(result).toMatch(/class Controller line=4 exported/);
    expect(result).toMatch(/function index line=5 exported/);
    expect(result).toMatch(/interface Service line=7 exported/);
    expect(result).toMatch(/function global_func line=8 exported/);
  });
});
