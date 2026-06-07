import test from 'ava';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool as createTool, RunContext } from '@openai/agents';
import { createGrepToolDefinition, formatGrepCommandMessage } from './grep.js';
import { toolErrorFunction, wrapToolInvoke } from '../lib/tool-invoke.js';

const execFileAsync = promisify(execFile);

function createWrappedGrepTool() {
  const definition = createGrepToolDefinition();
  return wrapToolInvoke(
    createTool({
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      strict: true,
      errorFunction: toolErrorFunction,
      execute: async (params, context, details) => definition.execute(params as any, context, details),
    }),
    definition.parameters,
    { argumentParsing: definition.argumentParsing },
  );
}

async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-grep-test-'));
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

test.serial('execute: file_pattern does not include gitignored files', async (t) => {
  await withTempDir(async (dir) => {
    await execFileAsync('git', ['init'], { cwd: dir });
    await fs.mkdir(path.join(dir, 'source'), { recursive: true });
    await fs.writeFile(path.join(dir, '.gitignore'), '*.tsbuildinfo\n');
    await fs.writeFile(path.join(dir, 'source', 'app.ts'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'tsconfig.tsbuildinfo'), '{"fileNames":["undo"]}\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'undo',
      path: '.',
      file_pattern: '*.ts*',
    });

    t.true(result.includes('source/app.ts'));
    t.false(result.includes('tsconfig.tsbuildinfo'));
  });
});

test.serial('execute: regex mode is the default', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.world\nhello-world\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello.world',
      path: '.',
    });

    t.true(result.includes('hello.world'));
    t.true(result.includes('hello-world'));
  });
});

test.serial('execute: searches are case-sensitive by default', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'axc\naXc\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'aXc',
      path: '.',
    });

    t.false(result.includes('axc'));
    t.true(result.includes('aXc'));
  });
});

test.serial('execute: case_sensitive false enables case-insensitive search', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'axc\naXc\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'aXc',
      path: '.',
      case_sensitive: false,
    });

    t.true(result.includes('axc'));
    t.true(result.includes('aXc'));
  });
});

test.serial('execute: regex mode supports parsed digit class patterns', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'testabc\ntest123\ntest456\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'test\\d+',
      path: '.',
    });

    t.false(result.includes('testabc'));
    t.true(result.includes('test123'));
    t.true(result.includes('test456'));
  });
});

test.serial('execute: regex mode supports parsed escaped dot patterns', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.hello\nhelloXhello\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello\\.hello',
      path: '.',
    });

    t.true(result.includes('hello.hello'));
    t.false(result.includes('helloXhello'));
  });
});

test.serial('invoke: grep uses strict JSON parsing before regex execution', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'testabc\ntest123\ntest456\n');
    const grep = createWrappedGrepTool();

    const validJsonResult = await grep.invoke({} as RunContext, String.raw`{"pattern":"test\\d+","path":"."}`, {});
    const invalidJsonResult = await grep.invoke({} as RunContext, String.raw`{"pattern":"test\d+","path":"."}`, {});

    t.true(String(validJsonResult).includes('test123'));
    t.true(String(validJsonResult).includes('test456'));
    t.false(String(validJsonResult).includes('testabc'));
    t.regex(String(invalidJsonResult), /Retry with/);
  });
});

test.serial('execute: literal mode uses fixed-string matching', async (t) => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.world\nhello-world\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello.world',
      path: '.',
      mode: 'literal',
    });

    t.true(result.includes('hello.world'));
    t.false(result.includes('hello-world'));
  });
});

test('formatGrepCommandMessage sets toolName to "grep" so the match counter uses the structured parser', (t) => {
  const item = {
    rawItem: {
      arguments: JSON.stringify({ pattern: 'hello', path: '.' }),
    },
    output: JSON.stringify({
      output: 'file1.ts:1:hello\nfile2.ts:3:hello',
    }),
  };

  const messages = formatGrepCommandMessage(item, 0, new Map());

  t.is(messages.length, 1);
  t.is(messages[0].toolName, 'grep');
});
