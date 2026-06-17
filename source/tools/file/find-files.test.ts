import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createFindFilesToolDefinition } from './find-files.js';
import { ExecutionContext } from '../../services/execution-context.js';

const findFilesToolDefinition = createFindFilesToolDefinition();
const findFilesToolDefinitionAllowOutside = createFindFilesToolDefinition({
  allowOutsideWorkspace: true,
});
const findFilesToolDefinitionFindFallback = createFindFilesToolDefinition({
  forceFindFallback: true,
});

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

it.sequential('execute: rejects patterns with path segments', async () => {
  await withTempDir(async (dir) => {
    await fs.mkdir(path.join(dir, 'src'));
    await fs.writeFile(path.join(dir, 'src/index.ts'), '');

    const result = await findFilesToolDefinitionFindFallback.execute({
      pattern: 'src/**/*',
    });

    expect(result.startsWith('Error')).toBe(true);
    expect(result.includes('basename-only')).toBe(true);
  });
});

it.sequential('execute: on SSH without fd, rejects patterns with path segments', async () => {
  await withTempDir(async () => {
    const sshService = {
      connect: async () => {},
      disconnect: async () => {},
      isConnected: () => true,
      executeCommand: async () => {
        throw new Error('fd not found');
      },
      readFile: async () => '',
      writeFile: async () => {},
      mkdir: async () => {},
    };
    const executionContext = new ExecutionContext(sshService);
    const tool = createFindFilesToolDefinition({ executionContext });

    const result = await tool.execute({
      pattern: 'src/**/*',
    });

    expect(result.includes('Error')).toBe(true);
    expect(result.includes('path')).toBe(true);
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

it.sequential('execute: rejects path outside workspace', async () => {
  await withTempDir(async () => {
    const result = await findFilesToolDefinition.execute({
      pattern: '*.ts',
      path: '/etc/outside',
    });

    expect(result.includes('Error')).toBe(true);
    expect(result.includes('outside workspace')).toBe(true);
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
