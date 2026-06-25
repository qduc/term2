import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { tool as createTool, RunContext } from '@openai/agents';
import { createFindFilesToolDefinition } from './glob.js';
import { ExecutionContext } from '../../services/execution-context.js';
import { toolErrorFunction, wrapToolInvoke } from '../../lib/tool-invoke.js';

const findFilesToolDefinition = createFindFilesToolDefinition();
const findFilesToolDefinitionAllowOutside = createFindFilesToolDefinition({
  allowOutsideWorkspace: true,
});
const findFilesToolDefinitionFindFallback = createFindFilesToolDefinition({
  forceFindFallback: true,
});
const findFilesToolDefinitionAllowOutsideFindFallback = createFindFilesToolDefinition({
  allowOutsideWorkspace: true,
  forceFindFallback: true,
});

function createWrappedFindFilesTool() {
  const definition = createFindFilesToolDefinition();
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

// Helper to create a temp dir and change cwd to it
async function withTempDir(run: (dir: string) => Promise<void>) {
  const originalCwd = process.cwd;
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-'));
  const workspaceDir = path.join(rootDir, 'workspace');
  await fs.mkdir(workspaceDir, { recursive: true });

  // Mock process.cwd (treat workspaceDir as the "workspace")
  process.cwd = () => workspaceDir;

  try {
    await run(workspaceDir);
  } finally {
    process.cwd = originalCwd;
    await fs.rm(rootDir, { recursive: true, force: true });
  }
}

it.sequential('needsApproval: returns false for read-only operation', async () => {
  await withTempDir(async () => {
    const result = await findFilesToolDefinition.needsApproval({
      pattern: '*.ts',
    });
    expect(result).toBe(false);
  });
});

it.sequential('schema: optional params can be omitted and null is rejected', async () => {
  await withTempDir(async () => {
    expect(findFilesToolDefinition.parameters.safeParse({ pattern: '*.ts' }).success).toBe(true);
    expect(findFilesToolDefinition.parameters.safeParse({ pattern: '*.ts', path: null }).success).toBe(false);
    expect(findFilesToolDefinition.parameters.safeParse({ pattern: '*.ts', max_results: null }).success).toBe(false);
  });
});

it.sequential('invoke: glob uses strict JSON parsing for glob patterns', async () => {
  await withTempDir(async () => {
    const glob = createWrappedFindFilesTool();

    const result = await glob.invoke({} as RunContext, '{"pattern":"*.ts\n"}', {});

    expect(String(result)).toMatch(/Tool input did not match schema for glob|Tool input was invalid for this tool/);
    expect(String(result)).toMatch(/Retry with/);
  });
});

it.sequential('execute: finds files by exact name', async () => {
  await withTempDir(async (dir) => {
    // Create test files
    await fs.writeFile(path.join(dir, 'test.ts'), '');
    await fs.writeFile(path.join(dir, 'other.js'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: 'test.ts',
    });

    expect(result.includes('test.ts')).toBe(true);
    expect(result.includes('other.js')).toBe(false);
  });
});

it.sequential('execute: finds files by glob pattern', async () => {
  await withTempDir(async (dir) => {
    // Create test files
    await fs.writeFile(path.join(dir, 'file1.ts'), '');
    await fs.writeFile(path.join(dir, 'file2.ts'), '');
    await fs.writeFile(path.join(dir, 'file3.js'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
    });

    expect(result.includes('file1.ts')).toBe(true);
    expect(result.includes('file2.ts')).toBe(true);
    expect(result.includes('file3.js')).toBe(false);
  });
});

it.sequential('execute: finds files in nested directories with glob pattern', async () => {
  await withTempDir(async (dir) => {
    // Create nested directory structure
    await fs.mkdir(path.join(dir, 'src'));
    await fs.mkdir(path.join(dir, 'src/utils'));
    await fs.writeFile(path.join(dir, 'src/index.ts'), '');
    await fs.writeFile(path.join(dir, 'src/utils/helper.ts'), '');
    await fs.writeFile(path.join(dir, 'readme.md'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
    });

    expect(result.includes('src/index.ts') || result.includes('index.ts')).toBe(true);
    expect(result.includes('src/utils/helper.ts') || result.includes('utils/helper.ts')).toBe(true);
    expect(result.includes('readme.md')).toBe(false);
  });
});

it.sequential('execute: supports patterns with path segments', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/index.ts'), '');

    const result = await findFilesToolDefinitionFindFallback.execute({
      pattern: 'src/**/*.ts',
    });

    expect(result.includes('src/index.ts')).toBe(true);
  });
});

it.sequential('execute: fd supports patterns with path segments', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/index.ts'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: 'src/**/*.ts',
    });

    expect(result.includes('src/index.ts')).toBe(true);
  });
});

it.sequential('execute: on SSH without fd, supports patterns with path segments', async () => {
  await withTempDir(async () => {
    const sshService = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      executeCommand: async (commandString: string) => {
        if (commandString.startsWith('fd')) {
          throw new Error('fd not found');
        }
        return {
          stdout: 'src/index.ts\n',
          stderr: '',
          exitCode: 0,
          timedOut: false,
        };
      },
      readFile: async () => '',
      writeFile: async () => {},
      mkdir: async () => {},
    };
    const executionContext = new ExecutionContext(sshService);
    const tool = createFindFilesToolDefinition({ executionContext });

    const result = await tool.execute({
      pattern: 'src/**/*.ts',
    });

    expect(result.includes('src/index.ts')).toBe(true);
  });
});

it.sequential('execute: restricts search to specified path', async () => {
  await withTempDir(async (dir) => {
    // Create nested directory structure
    await fs.mkdir(path.join(dir, 'src'));
    await fs.mkdir(path.join(dir, 'tests'));
    await fs.writeFile(path.join(dir, 'src/app.ts'), '');
    await fs.writeFile(path.join(dir, 'tests/app.test.ts'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
      path: 'src',
    });

    expect(result.includes('app.ts')).toBe(true);
    expect(result.includes('app.test.ts')).toBe(false);
  });
});

it.sequential('execute: respects max_results limit', async () => {
  await withTempDir(async (dir) => {
    // Create many files
    for (let i = 1; i <= 10; i++) {
      await fs.writeFile(path.join(dir, `file${i}.ts`), '');
    }

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
      max_results: 5,
    });

    const lines = result.trim().split('\n');
    // Should have 5 file results + empty line + 1 note line = 7 lines max
    expect(lines.length <= 8).toBe(true);
    expect(result.includes('Results limited to')).toBe(true);
  });
});

it.sequential('execute: handles no matches found', async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, 'file.js'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
    });

    expect(result.includes('No files found')).toBe(true);
  });
});

it.sequential('needsApproval: prompts for path outside workspace', async () => {
  await withTempDir(async () => {
    const result = await findFilesToolDefinition.needsApproval({
      pattern: '*.ts',
      path: '/etc/outside',
    });

    expect(result).toBe(true);
  });
});

it.sequential('execute: searches path outside workspace after approval path resolution', async () => {
  await withTempDir(async (dir) => {
    const outsideDir = path.join(dir, '..', 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'outside.ts'), '');
    await fs.writeFile(path.join(outsideDir, 'outside.js'), '');

    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
      path: '../outside',
    });

    expect(result.includes('outside.ts')).toBe(true);
    expect(result.includes('outside.js')).toBe(false);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: in allowOutsideWorkspace mode, can search outside workspace', async () => {
  await withTempDir(async (dir) => {
    const outsideDir = path.join(dir, '..', 'outside');
    await fs.mkdir(outsideDir, { recursive: true });
    await fs.writeFile(path.join(outsideDir, 'outside.ts'), '');
    await fs.writeFile(path.join(outsideDir, 'outside.js'), '');

    const result = await findFilesToolDefinitionAllowOutside.execute({
      pattern: '*.ts',
      path: '../outside',
    });

    expect(result.includes('outside.ts')).toBe(true);
    expect(result.includes('outside.js')).toBe(false);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: handles non-existent directory', async () => {
  await withTempDir(async () => {
    await expect(
      findFilesToolDefinition.execute({
        pattern: '*.ts',
        path: 'nonexistent',
      }),
    ).rejects.toThrow(/File search failed/);
  });
});

it.sequential('execute: uses pattern directory as search root when pattern is absolute path (fd)', async () => {
  await withTempDir(async () => {
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-glob-ext-'));

    try {
      await fs.writeFile(path.join(externalDir, 'run_test1.sh'), '');
      await fs.writeFile(path.join(externalDir, 'run_test2.sh'), '');
      await fs.writeFile(path.join(externalDir, 'other.txt'), '');

      const result = await findFilesToolDefinitionAllowOutside.execute({
        pattern: path.join(externalDir, 'run_*.sh'),
      });

      expect(result).not.toContain('No files found');
      expect(result).toContain('run_test1.sh');
      expect(result).toContain('run_test2.sh');
      expect(result).not.toContain('other.txt');
    } finally {
      await fs.rm(externalDir, { recursive: true, force: true });
    }
  });
});

it.sequential('execute: explicit path param takes precedence over absolute pattern directory', async () => {
  await withTempDir(async () => {
    const dirA = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-glob-a-'));
    const dirB = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-glob-b-'));

    try {
      await fs.writeFile(path.join(dirA, 'run_alpha.sh'), '');
      await fs.writeFile(path.join(dirB, 'run_beta.sh'), '');

      const result = await findFilesToolDefinitionAllowOutside.execute({
        pattern: path.join(dirA, 'run_*.sh'),
        path: dirB,
      });

      expect(result).toContain('run_beta.sh');
      expect(result).not.toContain('run_alpha.sh');
    } finally {
      await fs.rm(dirA, { recursive: true, force: true });
      await fs.rm(dirB, { recursive: true, force: true });
    }
  });
});

it.sequential(
  'execute: uses pattern directory as search root when pattern is absolute path (find fallback)',
  async () => {
    await withTempDir(async () => {
      const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), 'term2-test-glob-ext-'));

      try {
        await fs.writeFile(path.join(externalDir, 'run_test1.sh'), '');
        await fs.writeFile(path.join(externalDir, 'run_test2.sh'), '');
        await fs.writeFile(path.join(externalDir, 'other.txt'), '');

        const result = await findFilesToolDefinitionAllowOutsideFindFallback.execute({
          pattern: path.join(externalDir, 'run_*.sh'),
        });

        expect(result).not.toContain('No files found');
        expect(result).toContain('run_test1.sh');
        expect(result).toContain('run_test2.sh');
        expect(result).not.toContain('other.txt');
      } finally {
        await fs.rm(externalDir, { recursive: true, force: true });
      }
    });
  },
);
