import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tool as createTool, RunContext } from '@openai/agents';
import { createGrepToolDefinition, formatGrepCommandMessage } from './grep.js';
import { toolErrorFunction, wrapToolInvoke } from '../../lib/tool-invoke.js';
import { ExecutionContext } from '../../services/execution-context.js';

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

it.sequential('execute: include uses rg-style globs that can re-include gitignored files', async () => {
  await withTempDir(async (dir) => {
    await execFileAsync('git', ['init'], { cwd: dir });
    await fs.mkdir(path.join(dir, 'source'), { recursive: true });
    await fs.writeFile(path.join(dir, '.gitignore'), '*.tsbuildinfo\n');
    await fs.writeFile(path.join(dir, 'source', 'app.ts'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'tsconfig.tsbuildinfo'), '{"fileNames":["undo"]}\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'undo',
      path: '.',
      include: '*.ts*',
    });

    expect(result.includes('source/app.ts')).toBe(true);
    expect(result.includes('tsconfig.tsbuildinfo')).toBe(true);
  });
});

it.sequential('execute: regex mode is the default', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.world\nhello-world\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello.world',
      path: '.',
    });

    expect(result.includes('hello.world')).toBe(true);
    expect(result.includes('hello-world')).toBe(true);
  });
});

it.sequential('execute: searches are case-sensitive by default', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'axc\naXc\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'aXc',
      path: '.',
    });

    expect(result.includes('axc')).toBe(false);
    expect(result.includes('aXc')).toBe(true);
  });
});

it.sequential('execute: ignore_case true enables case-insensitive search', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'axc\naXc\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'aXc',
      path: '.',
      ignore_case: true,
    });

    expect(result.includes('axc')).toBe(true);
    expect(result.includes('aXc')).toBe(true);
  });
});

it.sequential('execute: regex mode supports parsed digit class patterns', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'testabc\ntest123\ntest456\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'test\\d+',
      path: '.',
    });

    expect(result.includes('testabc')).toBe(false);
    expect(result.includes('test123')).toBe(true);
    expect(result.includes('test456')).toBe(true);
  });
});

it.sequential('execute: regex mode supports parsed escaped dot patterns', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.hello\nhelloXhello\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello\\.hello',
      path: '.',
    });

    expect(result.includes('hello.hello')).toBe(true);
    expect(result.includes('helloXhello')).toBe(false);
  });
});

it.sequential('invoke: grep uses strict JSON parsing before regex execution', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'testabc\ntest123\ntest456\n');
    const grep = createWrappedGrepTool();

    const validJsonResult = await grep.invoke({} as RunContext, String.raw`{"pattern":"test\\d+","path":"."}`, {});
    const invalidJsonResult = await grep.invoke({} as RunContext, String.raw`{"pattern":"test\d+","path":"."}`, {});

    expect(String(validJsonResult).includes('test123')).toBe(true);
    expect(String(validJsonResult).includes('test456')).toBe(true);
    expect(String(validJsonResult).includes('testabc')).toBe(false);
    expect(String(invalidJsonResult)).toMatch(/Retry with/);
  });
});

it.sequential('execute: fixed_strings true uses fixed-string matching', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello.world\nhello-world\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'hello.world',
      path: '.',
      fixed_strings: true,
    });

    expect(result.includes('hello.world')).toBe(true);
    expect(result.includes('hello-world')).toBe(false);
  });
});

it.sequential('execute: searches paths containing spaces', async () => {
  await withTempDir(async (dir) => {
    const spacedDir = path.join(dir, 'docs plans');
    await fs.mkdir(spacedDir, { recursive: true });
    await fs.writeFile(path.join(spacedDir, 'notes.txt'), 'ship it\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'ship',
      path: 'docs plans',
    });

    expect(result.includes('docs plans/notes.txt')).toBe(true);
  });
});

it.sequential('execute: include patterns containing single quotes are treated as one glob argument', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "owner's-notes.txt"), 'target\n');
    await fs.writeFile(path.join(dir, 'other-notes.txt'), 'target\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'target',
      path: '.',
      include: "owner's-*.txt",
    });

    expect(result.includes("owner's-notes.txt")).toBe(true);
    expect(result.includes('other-notes.txt')).toBe(false);
  });
});

it.sequential('execute: passes rg-style include globs through before searching', async () => {
  const commands: string[] = [];
  const sshService = {
    connect: async () => {},
    disconnect: async () => {},
    isConnected: () => true,
    executeCommand: async (commandString: string) => {
      commands.push(commandString);
      if (commandString === 'rg --version') {
        return { stdout: 'ripgrep 14.0.0\n', stderr: '', exitCode: 0, timedOut: false };
      }
      return { stdout: 'source/app.ts:1:target\n', stderr: '', exitCode: 0, timedOut: false };
    },
    readFile: async () => '',
    writeFile: async () => {},
    mkdir: async () => {},
  };
  const executionContext = new ExecutionContext(sshService);

  await createGrepToolDefinition({ executionContext }).execute({
    pattern: 'target',
    path: '.',
    include: '*.ts',
  });

  expect(commands[1]).toContain("-g '*.ts'");
});

it('formatGrepCommandMessage sets toolName to "grep" so the match counter uses the structured parser', () => {
  const item = {
    rawItem: {
      arguments: JSON.stringify({ pattern: 'hello', path: '.' }),
    },
    output: JSON.stringify({
      output: 'file1.ts:1:hello\nfile2.ts:3:hello',
    }),
  };

  const messages = formatGrepCommandMessage(item, 0, new Map());

  expect(messages.length).toBe(1);
  expect(messages[0].toolName).toBe('grep');
});

it.sequential('execute: exclude pattern skips matching files', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'source'), { recursive: true });
    await fs.writeFile(path.join(dir, 'source', 'app.ts'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'source', 'config.json'), '{"value": "undo"}\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'undo',
      path: '.',
      exclude: '*.json',
    });

    expect(result.includes('source/app.ts')).toBe(true);
    expect(result.includes('source/config.json')).toBe(false);
  });
});

it.sequential('execute: include with brace expansion filters files correctly', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'source'), { recursive: true });
    await fs.writeFile(path.join(dir, 'source', 'app.ts'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'source', 'style.css'), 'const value = "undo";\n');
    await fs.writeFile(path.join(dir, 'source', 'notes.txt'), 'const value = "undo";\n');

    const result = await createGrepToolDefinition().execute({
      pattern: 'undo',
      path: '.',
      include: '*.{ts,css}',
    });

    expect(result.includes('source/app.ts')).toBe(true);
    expect(result.includes('source/style.css')).toBe(true);
    expect(result.includes('source/notes.txt')).toBe(false);
  });
});
