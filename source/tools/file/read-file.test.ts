import { it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { createReadFileToolDefinition } from './read-file.js';

it('orchestrator read_file description permits direct inspection', () => {
  const tool = createReadFileToolDefinition({ orchestratorMode: true });

  expect(tool.description).toContain('Inspect a known file directly');
  expect(tool.description).not.toContain('to verify a specific claim');
});

const readFileToolDefinition = createReadFileToolDefinition();
const readFileToolDefinitionAllowOutside = createReadFileToolDefinition({
  allowOutsideWorkspace: true,
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
    const result = await readFileToolDefinition.needsApproval({
      path: 'test.txt',
    });
    expect(result).toBe(false);
  });
});

it.sequential('schema: optional line params can be omitted and null is rejected', async () => {
  await withTempDir(async () => {
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt' }).success).toBe(true);
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt', start_line: null }).success).toBe(false);
    expect(readFileToolDefinition.parameters.safeParse({ path: 'test.txt', end_line: null }).success).toBe(false);
  });
});

it.sequential('execute: successfully reads a file', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Hello\nWorld\nFrom\nFile';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
    });

    // Result should include header and content
    expect(result.includes('File: test.txt')).toBe(true);
    expect(result.includes('4 lines')).toBe(true);
    expect(result.includes('Hello')).toBe(true);
    expect(result.includes('World')).toBe(true);
    expect(result.includes('From')).toBe(true);
    expect(result.includes('File')).toBe(true);
  });
});

it.sequential('execute: reads file with line range', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 2,
      end_line: 4,
    });

    // Should only include lines 2-4
    expect(result.includes('[lines 2-4]')).toBe(true);
    expect(result.includes('Line 1')).toBe(false);
    expect(result.includes('Line 2')).toBe(true);
    expect(result.includes('Line 3')).toBe(true);
    expect(result.includes('Line 4')).toBe(true);
    expect(result.includes('Line 5')).toBe(false);
  });
});

it.sequential('execute: reads file from start_line to end', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'test.txt';
    const content = 'Line 1\nLine 2\nLine 3\nLine 4\nLine 5';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 3,
    });

    // Should include lines 3-5
    expect(result.includes('[lines 3-5]')).toBe(true);
    expect(result.includes('Line 1')).toBe(false);
    expect(result.includes('Line 2')).toBe(false);
    expect(result.includes('Line 3')).toBe(true);
    expect(result.includes('Line 4')).toBe(true);
    expect(result.includes('Line 5')).toBe(true);
  });
});

it.sequential('needsApproval: prompts for path outside workspace', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: '/etc/outside.txt',
    });

    expect(result).toBe(true);
  });
});

it.sequential('needsApproval: does not prompt for discovered skill directories outside workspace', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.needsApproval({
      path: path.join(os.homedir(), '.agents', 'skills', 'example-skill', 'SKILL.md'),
    });

    expect(result).toBe(false);
  });
});

it.sequential('execute: reads path outside workspace after approval path resolution', async () => {
  await withTempDir(async (dir) => {
    const outsidePath = path.join(dir, '..', 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\ncontent');

    const result = await readFileToolDefinition.execute({
      path: '../outside.txt',
    });

    expect(result.includes('outside')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: in allowOutsideWorkspace mode, can read outside workspace', async () => {
  await withTempDir(async (dir) => {
    const outsidePath = path.join(dir, '..', 'outside.txt');
    await fs.writeFile(outsidePath, 'outside\ncontent');

    const result = await readFileToolDefinitionAllowOutside.execute({
      path: '../outside.txt',
    });

    expect(result.includes('outside')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('content')).toBe(true);
    expect(result.includes('outside workspace')).toBe(false);
  });
});

it.sequential('execute: expands ~ to home directory in allowOutsideWorkspace mode', async () => {
  await withTempDir(async () => {
    // We try to read ~/.ssh/config or something likely to exist,
    // but better to just mock homedir if we could.
    // Given the constraints, we can at least verify it doesn't throw a malformed path error
    // even if the file doesn't exist.
    const result = await readFileToolDefinitionAllowOutside.execute({
      path: '~/nonexistent_file_for_test_' + Date.now(),
    });

    // Should not fail with "Operation outside workspace" if expansion worked
    expect(result.includes('Operation outside workspace')).toBe(false);
    expect(result.includes('Error: File not found') || result.includes('ENOENT')).toBe(true);
  });
});

it.sequential('execute: handles file not found', async () => {
  await withTempDir(async () => {
    const result = await readFileToolDefinition.execute({
      path: 'nonexistent.txt',
    });

    expect(result.includes('Error')).toBe(true);
    expect(result.includes('ENOENT') || result.includes('not found')).toBe(true);
  });
});

it.sequential('execute: handles empty file', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'empty.txt';
    await fs.writeFile(path.join(dir, filePath), '');

    const result = await readFileToolDefinition.execute({
      path: filePath,
    });

    expect(result.trim()).toBe('');
  });
});

it.sequential('execute: handles line range beyond file length', async () => {
  await withTempDir(async (dir) => {
    const filePath = 'short.txt';
    const content = 'Line 1\nLine 2';
    await fs.writeFile(path.join(dir, filePath), content);

    const result = await readFileToolDefinition.execute({
      path: filePath,
      start_line: 1,
      end_line: 10,
    });

    // Should only include available lines
    expect(result.includes('Line 1')).toBe(true);
    expect(result.includes('Line 2')).toBe(true);
    expect(result.includes('2 lines')).toBe(true);
  });
});
