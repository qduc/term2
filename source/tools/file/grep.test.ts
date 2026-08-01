import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createGrepToolDefinition, formatGrepCommandMessage } from './grep.js';
import { wrapToolInvoke } from '../../lib/tool-invoke.js';
import type { ToolDefinition } from '../../tools/types.js';
import { ExecutionContext } from '../../services/execution-context.js';

it('orchestrator grep description permits direct targeted investigation', () => {
  const tool = createGrepToolDefinition({ orchestratorMode: true });

  expect(tool.description).toContain('Search directly for a symbol, string, or pattern');
  expect(tool.description).not.toContain('when you already have a target in mind');
});

it('description references glob when glob is available and shell when it is not', () => {
  const defaultTool = createGrepToolDefinition();
  expect(defaultTool.description).toContain('use glob');
  expect(defaultTool.description).not.toContain('use shell');

  const shellTool = createGrepToolDefinition({ globAvailable: false });
  expect(shellTool.description).toContain('use shell');
  expect(shellTool.description).not.toContain('use glob');

  const orchestratorShellTool = createGrepToolDefinition({ orchestratorMode: true, globAvailable: false });
  expect(orchestratorShellTool.description).toContain('use shell');
  expect(orchestratorShellTool.description).not.toContain('use glob');
});

const execFileAsync = promisify(execFile);

function createWrappedGrepTool() {
  const definition = createGrepToolDefinition();
  return wrapToolInvoke(definition, definition.parameters, {
    argumentParsing: definition.argumentParsing,
  }) as ToolDefinition & { name: string };
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

    const validJsonResult = await grep.execute(String.raw`{"pattern":"test\\d+","path":"."}`, undefined, {});
    const invalidJsonResult = await grep.execute(String.raw`{"pattern":"test\d+","path":"."}`, undefined, {});

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

// Regression: grep declared `needsApproval: () => false` with the comment
// "Search is read-only and safe". Read-only is not the same as in-bounds — the
// `path` parameter is passed through to a shell `rg`/`grep -r` invocation with
// no sandbox wrapper, so an out-of-workspace path was an unapproved filesystem
// read. glob and read_file already enforced this boundary; grep did not.
it('grep requires approval for a path outside the workspace', async () => {
  const definition = createGrepToolDefinition({
    executionContext: { getCwd: () => '/tmp/some-workspace' } as any,
  });

  const inside = await definition.needsApproval!({ pattern: 'x', path: 'src' } as any, {} as any);
  const outside = await definition.needsApproval!({ pattern: 'x', path: '/etc' } as any, {} as any);
  const traversal = await definition.needsApproval!({ pattern: 'x', path: '../../..' } as any, {} as any);

  expect(inside).toBe(false);
  expect(outside).toBe(true);
  expect(traversal).toBe(true);
});

it('grep skips the workspace boundary check in lite mode (allowOutsideWorkspace)', async () => {
  const definition = createGrepToolDefinition({
    executionContext: { getCwd: () => '/tmp/some-workspace' } as any,
    allowOutsideWorkspace: true,
  });

  expect(await definition.needsApproval!({ pattern: 'x', path: '/etc' } as any, {} as any)).toBe(false);
});
